/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Logger } from "@utils/Logger";
import definePlugin from "@utils/types";
import { MediaEngineStore, SelectedChannelStore, UserStore, VoiceActions } from "@webpack/common";

import { VoiceStateService } from "./service";
import { resetFakeModes, setFakeMode } from "./state";
import { applyOverrides, createDefaultFlags, type FakeVoiceFlags, type VoiceStateKey, type VoiceStatePayload } from "./types";

let service: VoiceStateService | null = null;
let flags: FakeVoiceFlags = createDefaultFlags();
let toggling = false;
let generation = 0;
const logger = new Logger("FakeDeafen");

function resetVoiceModes() {
    generation++;
    toggling = false;
    flags = createDefaultFlags();
    resetFakeModes("mute", "deafen");
}

async function handleToggle(key: VoiceStateKey): Promise<void> {
    if (toggling) return;
    toggling = true;
    const operation = generation;
    const mode = key === "selfMute" ? "mute" : "deafen";
    const channelId = SelectedChannelStore.getVoiceChannelId();
    setFakeMode(mode, { pending: true, error: null });
    try {
        const next = { ...flags, [key]: !flags[key] };
        if (key === "selfDeaf" && next.selfDeaf) {
            if (!SelectedChannelStore.getVoiceChannelId()) {
                throw new Error("Join a voice channel before enabling Fake Deafen.");
            }
            if (MediaEngineStore.isSelfDeaf()) {
                throw new Error("Turn off Discord deafen before enabling Fake Deafen.");
            }
            if (!MediaEngineStore.isSelfMute()) {
                await VoiceActions.toggleSelfMute();
                if (operation !== generation) return;
                if (channelId !== SelectedChannelStore.getVoiceChannelId()) {
                    throw new Error("Your voice channel changed. Try again in your current call.");
                }
                if (!MediaEngineStore.isSelfMute() || MediaEngineStore.isSelfDeaf()) {
                    throw new Error("Could not mute your microphone. Fake Deafen was not enabled.");
                }
            }
        }
        if (!service?.triggerUpdate(next)) {
            throw new Error("Could not update your voice state. Join a voice channel and try again.");
        }
        flags = next;
        setFakeMode(mode, { active: next[key] });
    } catch (error) {
        logger.error("Could not change voice state", error);
        if (operation !== generation) return;
        const text = error instanceof Error ? error.message : "Could not change voice state. Try again.";
        setFakeMode(mode, { error: text });
    } finally {
        if (operation === generation) {
            toggling = false;
            setFakeMode(mode, { pending: false });
        }
    }
}

export default definePlugin({
    name: "FakeDeafen",
    description: "Pretend ur deaf while secretly listening to every bit of drama",
    authors: [{ id: 1128391811136770128n, name: "@kon" }],
    tags: ["Voice", "Privacy"],

    toggleMute: () => handleToggle("selfMute"),
    toggleDeafen: () => handleToggle("selfDeaf"),

    modifyVoiceState(voiceState: VoiceStatePayload): VoiceStatePayload {
        return applyOverrides(voiceState, flags);
    },

    patches: [
        {
            find: "voiceServerPing(){",
            replacement: [
                {
                    match: /voiceStateUpdate\((\w+)\){(.{0,10})guildId:/,
                    replace: "voiceStateUpdate($1){$1=$self.modifyVoiceState($1);$2guildId:"
                }
            ]
        }
    ],

    flux: {
        CONNECTION_CLOSED: resetVoiceModes,
        VOICE_STATE_UPDATES({ voiceStates }: { voiceStates: { userId: string; channelId: string | null; }[]; }) {
            const userId = UserStore.getCurrentUser()?.id;
            if (voiceStates.some(state => state.userId === userId && !state.channelId)) resetVoiceModes();
        }
    },

    start() {
        resetVoiceModes();
        service = new VoiceStateService();
    },

    stop() {
        resetVoiceModes();
        if (service) {
            service.triggerUpdate(createDefaultFlags());
            service = null;
        }
    }
});
