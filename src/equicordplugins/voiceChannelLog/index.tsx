/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { NavContextMenuPatchCallback } from "@api/ContextMenu";
import { Devs, EquicordDevs } from "@utils/constants";
import definePlugin from "@utils/types";
import { ChannelType } from "@vencord/discord-types/enums";
import { findByPropsLazy } from "@webpack";
import { ApplicationStore, ChannelStore, GuildStore, Menu, RelationshipStore, SelectedChannelStore, UserStore, VoiceStateStore } from "@webpack/common";

import { LogIcon, OpenLogsButton } from "./components/LogsButton";
import { openVoiceChannelLog } from "./components/VoiceChannelLogModal";
import { addLogEntry, flushHistory, openHistory, pruneHistory } from "./logs";
import settings from "./settings";
import { EmbeddedActivityEvent, LogEventType, PreviousVoiceState, SoundEvent, VoiceChannelLogEntry, VoiceState } from "./types";
import { getVoiceEvents, getVoiceFlags, toPreviousState } from "./voiceEvents";

const { fetchApplication } = findByPropsLazy("fetchApplication");

const JOIN_SYNC_WINDOW_MS = 5000;
const PRUNE_CHECK_MS = 6 * 60 * 60 * 1000;

const EVENT_SETTINGS: Partial<Record<LogEventType, keyof typeof settings.store>> = {
    join: "logJoinLeave",
    leave: "logJoinLeave",
    move: "logJoinLeave",
    present: "logJoinLeave",
    self_mute: "logSelfMuteDeafen",
    self_deafen: "logSelfMuteDeafen",
    server_mute: "logMuteDeafen",
    server_deafen: "logMuteDeafen",
    self_video: "logVideo",
    self_stream: "logStream"
};

const loggedActivities = new Set<string>();
const previousStates = new Map<string, PreviousVoiceState>();

let currentChannelId: string | null = null;
let callStartedAt: number | null = null;
let entryCount = 0;
let pruneTimer: ReturnType<typeof setInterval> | undefined;

function shouldLog(userId: string): boolean {
    return !(settings.store.ignoreBlockedUsers && RelationshipStore.isBlocked(userId));
}

function isEnabled(type: LogEventType): boolean {
    const setting = EVENT_SETTINGS[type];
    return !setting || !!settings.store[setting];
}

function getChannelName(channelId?: string | null): string | undefined {
    if (!channelId) return undefined;

    const channel = ChannelStore.getChannel(channelId);
    if (!channel) return undefined;

    return channel.name || (channel.isDM() ? "Direct message" : "Group call");
}

function log(entry: Pick<VoiceChannelLogEntry, "type" | "userId" | "channelId"> & Partial<VoiceChannelLogEntry>) {
    const guildId = ChannelStore.getChannel(entry.channelId)?.guild_id ?? undefined;
    const user = UserStore.getUser(entry.userId);
    const now = new Date();

    addLogEntry({
        ...entry,
        id: `${now.getTime().toString(36)}-${++entryCount}`,
        timestamp: now,
        callStartedAt: callStartedAt ?? undefined,
        guildId,
        guildName: guildId ? GuildStore.getGuild(guildId)?.name : undefined,
        channelName: getChannelName(entry.channelId),
        oldChannelName: getChannelName(entry.oldChannelId),
        newChannelName: getChannelName(entry.newChannelId),
        username: user?.username,
        displayName: user?.globalName ?? user?.username,
        avatar: user?.avatar ?? undefined
    });
}

/** Moves recording to the channel we are now in. Runs for every way of changing channels. */
function syncVoiceChannel(nextChannelId: string | null) {
    const previousChannelId = currentChannelId;
    if (previousChannelId === nextChannelId) return;

    const userId = UserStore.getCurrentUser()?.id;
    const logSelf = !!userId && settings.store.logJoinLeave;

    if (logSelf && previousChannelId) {
        log(nextChannelId
            ? { type: "move", userId, channelId: previousChannelId, oldChannelId: previousChannelId, newChannelId: nextChannelId }
            : { type: "leave", userId, channelId: previousChannelId });
    }

    previousStates.clear();
    loggedActivities.clear();
    currentChannelId = nextChannelId;
    callStartedAt = nextChannelId ? Date.now() : null;

    if (!nextChannelId) return;

    if (logSelf) {
        log(previousChannelId
            ? { type: "move", userId, channelId: nextChannelId, oldChannelId: previousChannelId, newChannelId: nextChannelId }
            : { type: "join", userId, channelId: nextChannelId });
    }

    // Without this baseline, the first change anyone makes after we join would have nothing to compare to.
    for (const [memberId, voiceState] of Object.entries(VoiceStateStore.getVoiceStatesForChannel(nextChannelId))) {
        const state = { ...toPreviousState(voiceState), channelId: nextChannelId };
        previousStates.set(memberId, state);

        if (memberId !== userId && settings.store.logJoinLeave && shouldLog(memberId)) {
            log({ type: "present", userId: memberId, channelId: nextChannelId, flags: getVoiceFlags(state) });
        }
    }
}

function syncAccount() {
    const userId = UserStore.getCurrentUser()?.id;
    if (userId) openHistory(userId);
}

function saveBeforeClosing() {
    void flushHistory();
}

const VOICE_CHANNEL_TYPES = new Set([ChannelType.GUILD_VOICE, ChannelType.GUILD_STAGE_VOICE, ChannelType.DM, ChannelType.GROUP_DM]);

const patchChannelContextMenu: NavContextMenuPatchCallback = (children, { channel }) => {
    if (!VOICE_CHANNEL_TYPES.has(channel.type)) return;
    children.push(
        <Menu.MenuItem
            id="vc-view-voice-channel-logs"
            label="View Voice Channel Logs"
            action={() => openVoiceChannelLog(channel)}
        />
    );
};

export default definePlugin({
    name: "VoiceChannelLog",
    description: "Logs voice channel activity including joins, leaves, soundboard, mute, camera, screenshare, and more.",
    tags: ["Servers", "Utility", "Voice"],
    authors: [Devs.Sqaaakoi, Devs.thororen, EquicordDevs.nyx, Devs.Moxxie, EquicordDevs.Fres, Devs.amy],
    dependencies: ["AudioPlayerAPI", "HeaderBarAPI"],
    settings,
    contextMenus: {
        "channel-context": patchChannelContextMenu
    },

    toolboxActions: {
        "Voice Channel Logs"() {
            const channelId = SelectedChannelStore.getVoiceChannelId();
            openVoiceChannelLog(channelId ? ChannelStore.getChannel(channelId) : undefined);
        }
    },

    headerBarButton: {
        icon: LogIcon,
        render: OpenLogsButton
    },

    flux: {
        CONNECTION_OPEN() {
            syncAccount();
        },

        VOICE_CHANNEL_SELECT({ channelId }: { channelId: string | null; }) {
            syncVoiceChannel(channelId ?? null);
        },

        VOICE_STATE_UPDATES({ voiceStates }: { voiceStates: VoiceState[]; }) {
            const clientUserId = UserStore.getCurrentUser()?.id;
            const joinedRecently = callStartedAt != null && Date.now() - callStartedAt < JOIN_SYNC_WINDOW_MS;
            let ownStateChanged = false;

            for (const state of voiceStates) {
                const { userId, oldChannelId } = state;
                const isMe = userId === clientUserId;

                if (isMe) ownStateChanged = true;
                if (!shouldLog(userId)) continue;

                const next = toPreviousState(state);
                const previous = previousStates.get(userId);

                for (const event of getVoiceEvents({ myChannelId: currentChannelId, previous, next, oldChannelId, isMe, joinedRecently })) {
                    if (isEnabled(event.type)) log({ ...event, userId });
                }

                if (next.channelId && next.channelId === currentChannelId) previousStates.set(userId, next);
                else previousStates.delete(userId);
            }

            // Being moved by a moderator changes our channel without a VOICE_CHANNEL_SELECT.
            if (ownStateChanged) {
                setTimeout(() => syncVoiceChannel(SelectedChannelStore.getVoiceChannelId() ?? null));
            }
        },

        EMBEDDED_ACTIVITY_UPDATE_V2(event: EmbeddedActivityEvent) {
            if (!settings.store.logActivity) return;

            const channelId = event.location?.channel_id;
            if (!channelId || channelId !== currentChannelId) return;

            const appId = event.applicationId;
            const currentUserIds = new Set((event.participants ?? []).map(p => p.user_id));

            const joined: string[] = [];
            for (const p of event.participants ?? []) {
                if (!shouldLog(p.user_id)) continue;
                const dedupKey = `${p.user_id}-${appId}`;
                if (loggedActivities.has(dedupKey)) continue;
                loggedActivities.add(dedupKey);
                joined.push(p.user_id);
            }

            const left: string[] = [];
            for (const key of loggedActivities) {
                if (!key.endsWith(`-${appId}`)) continue;
                const userId = key.slice(0, -(appId.length + 1));
                if (!currentUserIds.has(userId)) {
                    loggedActivities.delete(key);
                    left.push(userId);
                }
            }

            if (!joined.length && !left.length) return;

            const app = ApplicationStore.getApplication(appId);
            const logWithName = (activityName: string) => {
                for (const userId of joined)
                    log({ type: "activity", userId, channelId, activityName, applicationId: appId });
                for (const userId of left)
                    log({ type: "activity_stop", userId, channelId, activityName, applicationId: appId });
            };

            if (app) {
                logWithName(app.name);
            } else {
                fetchApplication(appId).then(fetched => logWithName(fetched?.name ?? "Unknown activity")).catch(() => logWithName("Unknown activity"));
            }
        },

        VOICE_CHANNEL_EFFECT_SEND(event: SoundEvent) {
            if (!settings.store.logSoundboard) return;
            if (!event.soundId) return;
            if (event.channelId !== currentChannelId) return;
            if (!shouldLog(event.userId)) return;

            log({
                type: "soundboard",
                userId: event.userId,
                channelId: event.channelId,
                soundId: event.soundId,
                emoji: event.emoji
            });
        }
    },

    start() {
        syncAccount();
        syncVoiceChannel(SelectedChannelStore.getVoiceChannelId() ?? null);
        window.addEventListener("beforeunload", saveBeforeClosing);
        pruneTimer = setInterval(pruneHistory, PRUNE_CHECK_MS);
    },

    stop() {
        window.removeEventListener("beforeunload", saveBeforeClosing);
        clearInterval(pruneTimer);
        previousStates.clear();
        loggedActivities.clear();
        currentChannelId = null;
        callStartedAt = null;
        void flushHistory();
    }
});
