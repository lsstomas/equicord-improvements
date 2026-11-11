/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Paragraph } from "@components/Paragraph";
import { Logger } from "@utils/Logger";
import definePlugin from "@utils/types";
import { VoiceState } from "@vencord/discord-types";
import { findByPropsLazy, findStoreLazy } from "@webpack";
import { ApplicationStreamingStore, ChannelStore, MediaEngineStore, PermissionsBits, PermissionStore, SelectedChannelStore, showToast, UserStore } from "@webpack/common";

import FakeDeafen from "../fakeDeafen";
import { VoiceStateService } from "../fakeDeafen/service";
import { resetFakeModes, setFakeMode } from "../fakeDeafen/state";
import { VoiceStatePayload } from "../fakeDeafen/types";

const logger = new Logger("FakeMedia");
const Gateway = findByPropsLazy("getSocket") as {
    getSocket(): { send(op: number, data: Record<string, unknown>): void; } | undefined;
};
const StreamRTCStore = findStoreLazy("StreamRTCConnectionStore") as { getRTCConnection(key: string): unknown; };

let cameraChannel: string | null = null;
let rtcGuardReady = false;
let fakeStream: { key: string; channelId: string; } | null = null;
let confirmationTimer: ReturnType<typeof setTimeout> | undefined;

function notify(text: string, failure = false) {
    showToast({ text, variant: failure ? "critical" : "success" });
}

function resetStream() {
    clearTimeout(confirmationTimer);
    confirmationTimer = undefined;
    fakeStream = null;
    resetFakeModes("screen");
}

function stopFakeStream() {
    if (!fakeStream) return;
    const socket = Gateway.getSocket();
    if (!socket) throw new Error("Discord is disconnected.");
    socket.send(19, { stream_key: fakeStream.key });
    resetStream();
}

function sendCameraState() {
    const channelId = SelectedChannelStore.getVoiceChannelId();
    if (!channelId) throw new Error("Join a voice channel before using Fake Camera.");
    const channel = ChannelStore.getChannel(channelId);
    const socket = Gateway.getSocket();
    if (!channel || !socket) throw new Error("Join a voice channel before using Fake Camera.");
    const state = FakeDeafen.modifyVoiceState({
        selfMute: MediaEngineStore.isSelfMute(),
        selfDeaf: MediaEngineStore.isSelfDeaf(),
        selfVideo: cameraChannel === channelId || MediaEngineStore.isVideoEnabled()
    });
    socket.send(4, {
        guild_id: channel.guild_id ?? null,
        channel_id: channelId,
        self_mute: state.selfMute,
        self_deaf: state.selfDeaf,
        self_video: state.selfVideo
    });
}

function toggleCamera() {
    const previous = cameraChannel;
    setFakeMode("camera", { pending: true, error: null });
    try {
        const channelId = SelectedChannelStore.getVoiceChannelId();
        if (!channelId) throw new Error("Join a voice channel before using Fake Camera.");
        if (!cameraChannel && MediaEngineStore.isVideoEnabled()) {
            throw new Error("Turn off your real camera before enabling Fake Camera.");
        }
        cameraChannel = cameraChannel ? null : channelId;
        sendCameraState();
        setFakeMode("camera", { active: cameraChannel !== null });
        notify(cameraChannel ? "Fake Camera requested. Your real camera stays off." : "Fake Camera disabled.");
    } catch (error) {
        cameraChannel = previous;
        logger.error("Could not update camera state", error);
        const text = error instanceof Error ? error.message : "Could not update camera state.";
        setFakeMode("camera", { error: text });
        notify(text, true);
    } finally {
        setFakeMode("camera", { pending: false });
    }
}

function toggleScreenShare() {
    let starting = false;
    setFakeMode("screen", { error: null });
    try {
        if (fakeStream) {
            stopFakeStream();
            notify("Fake Screen Share disabled.");
            return;
        }
        const channelId = SelectedChannelStore.getVoiceChannelId();
        if (!channelId) throw new Error("Join a voice channel before using Fake Screen Share.");
        const channel = ChannelStore.getChannel(channelId);
        const user = UserStore.getCurrentUser();
        const socket = Gateway.getSocket();
        if (!channel || !user || !socket) throw new Error("Join a voice channel before using Fake Screen Share.");
        if (ApplicationStreamingStore.getCurrentUserActiveStream()) {
            throw new Error("Stop your current screen share before enabling Fake Screen Share.");
        }
        if (channel.guild_id && !PermissionStore.can(PermissionsBits.STREAM, channel)) {
            throw new Error("You do not have permission to stream in this channel.");
        }
        StreamRTCStore.getRTCConnection("");
        if (!rtcGuardReady) throw new Error("Fake Screen Share capture protection is unavailable. Restart Discord or update the plugin.");
        const key = channel.guild_id
            ? `guild:${channel.guild_id}:${channelId}:${user.id}`
            : `call:${channelId}:${user.id}`;
        starting = true;
        fakeStream = { key, channelId };
        setFakeMode("screen", { pending: true, active: false });
        socket.send(18, {
            type: channel.guild_id ? "guild" : "call",
            guild_id: channel.guild_id ?? null,
            channel_id: channelId,
            preferred_region: channel.rtcRegion ?? null
        });
        confirmationTimer = setTimeout(() => {
            try {
                stopFakeStream();
            } catch (error) {
                logger.error("Could not cancel unconfirmed stream", error);
                resetStream();
            }
            const text = "Discord did not confirm Fake Screen Share. The request was cancelled.";
            setFakeMode("screen", { error: text });
            notify(text, true);
        }, 15000);
        notify("Fake Screen Share requested. Waiting for Discord.");
    } catch (error) {
        logger.error("Could not update stream state", error);
        if (starting) resetStream();
        const text = error instanceof Error ? error.message : "Could not update stream state.";
        setFakeMode("screen", { error: text });
        notify(text, true);
    }
}

export default definePlugin({
    name: "FakeMedia",
    description: "Advertises a camera or screen share without starting local capture.",
    authors: [{ name: "Local customization", id: 0n }],
    tags: ["Voice", "Media"],
    enabledByDefault: true,
    dependencies: ["FakeDeafen"],
    settingsAboutComponent: () => <Paragraph>
        Use the mask button in your voice panel or call controls. Camera and screen loading indicators depend on the other client's behavior.
        Discord may end the stream or show an error. Disable fake modes before using real video or sharing.
    </Paragraph>,
    toggleCamera,
    toggleScreenShare,
    toolboxActions: {
        "Toggle Fake Camera": toggleCamera,
        "Toggle Fake Screen Share": toggleScreenShare
    },
    modifyCameraState(state: VoiceStatePayload): VoiceStatePayload {
        if (!cameraChannel || state.channelId !== cameraChannel) return state;
        return { ...state, selfVideo: true };
    },
    isFakeStream(key: string): boolean {
        return fakeStream?.key === key;
    },
    markRtcGuardReady() {
        rtcGuardReady = true;
    },
    patches: [
        {
            find: "voiceServerPing(){",
            replacement: {
                match: /voiceStateUpdate\((\i)\)\{/,
                replace: "voiceStateUpdate($1){$1=$self.modifyCameraState($1);"
            }
        },
        {
            find: '.destroy("stream-end")',
            group: true,
            replacement: [
                {
                    match: /getRTCConnection\(\i\)\{/,
                    replace: "$&$self.markRtcGuardReady();"
                },
                {
                    match: /STREAM_CREATE:function\((\i)\)\{/,
                    replace: "$&if($self.isFakeStream($1.streamKey))return false;"
                }
            ]
        }
    ],
    flux: {
        STREAM_CREATE({ streamKey }: { streamKey: string; }) {
            if (streamKey !== fakeStream?.key) return;
            clearTimeout(confirmationTimer);
            confirmationTimer = undefined;
            setFakeMode("screen", { active: true, pending: false, error: null });
            notify("Fake Screen Share confirmed by Discord. No screen is captured.");
        },
        STREAM_DELETE({ streamKey }: { streamKey: string; }) {
            if (streamKey !== fakeStream?.key) return;
            resetStream();
            setFakeMode("screen", { error: "Discord ended Fake Screen Share." });
            notify("Discord ended Fake Screen Share.", true);
        },
        STREAM_START() {
            resetStream();
        },
        VOICE_STATE_UPDATES({ voiceStates }: { voiceStates: VoiceState[]; }) {
            const userId = UserStore.getCurrentUser()?.id;
            const state = voiceStates.find(s => s.userId === userId);
            if (!state) return;
            if (cameraChannel && state.channelId !== cameraChannel) {
                cameraChannel = null;
                resetFakeModes("camera");
            }
            if (fakeStream && state.channelId !== fakeStream.channelId) {
                try {
                    stopFakeStream();
                } finally {
                    resetStream();
                }
            }
        },
        CONNECTION_CLOSED() {
            cameraChannel = null;
            resetFakeModes("camera");
            resetStream();
        }
    },
    start() {
        cameraChannel = null;
        resetFakeModes("camera");
        resetStream();
        VoiceStateService.cameraOverride = channelId => cameraChannel === channelId;
    },
    stop() {
        try {
            stopFakeStream();
        } catch (error) {
            logger.error("Could not clear fake stream state", error);
        }
        try {
            if (cameraChannel) {
                cameraChannel = null;
                if (SelectedChannelStore.getVoiceChannelId()) sendCameraState();
            }
        } catch (error) {
            logger.error("Could not clear fake media state", error);
        } finally {
            VoiceStateService.cameraOverride = undefined;
            cameraChannel = null;
            resetFakeModes("camera");
            resetStream();
        }
    }
});
