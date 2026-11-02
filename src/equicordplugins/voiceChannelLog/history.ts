/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { createDayStore, DayStoreOptions, DayStoreStorage, getDayKey } from "./dayStore";
import { LogEventType, VoiceChannelLogEntry } from "./types";

export { getDayKey };

export type HistoryStorage = DayStoreStorage;
export type HistoryOptions = Omit<DayStoreOptions<VoiceChannelLogEntry>, "getTime" | "revive">;

export type EventGroup = "all" | "presence" | "voice" | "camera" | "stream" | "soundboard" | "activity";

export interface LogFilter {
    /** null shows every channel. */
    channelId: string | null;
    group: EventGroup;
    query: string;
}

export const EVENT_GROUPS: { label: string; value: EventGroup; }[] = [
    { label: "All events", value: "all" },
    { label: "Joins and leaves", value: "presence" },
    { label: "Mute and deafen", value: "voice" },
    { label: "Camera", value: "camera" },
    { label: "Screenshare", value: "stream" },
    { label: "Soundboard", value: "soundboard" },
    { label: "Activities", value: "activity" }
];

const GROUP_BY_TYPE: Record<LogEventType, EventGroup> = {
    join: "presence",
    leave: "presence",
    move: "presence",
    present: "presence",
    self_mute: "voice",
    self_deafen: "voice",
    server_mute: "voice",
    server_deafen: "voice",
    self_video: "camera",
    self_stream: "stream",
    soundboard: "soundboard",
    activity: "activity",
    activity_stop: "activity"
};

function reviveEntry(raw: unknown): VoiceChannelLogEntry | null {
    if (!raw || typeof raw !== "object") return null;

    const entry = raw as VoiceChannelLogEntry;
    if (typeof entry.type !== "string" || typeof entry.channelId !== "string" || typeof entry.userId !== "string") return null;

    const timestamp = new Date(entry.timestamp);
    return Number.isNaN(timestamp.getTime()) ? null : { ...entry, timestamp };
}

export function createHistoryStore(storage: HistoryStorage, options: HistoryOptions) {
    const store = createDayStore<VoiceChannelLogEntry>(storage, {
        ...options,
        getTime: entry => entry.timestamp,
        getId: entry => entry.id,
        revive: reviveEntry
    });

    return {
        ...store,
        /** Deletes one channel's logs, or every log when no channel is given. */
        clear: (channelId?: string) => store.clear(channelId ? entry => entry.channelId === channelId : undefined)
    };
}

export function getUserLabel(entry: VoiceChannelLogEntry): string {
    return entry.displayName ?? entry.username ?? "Unknown";
}

export function getChannelLabel(entry: VoiceChannelLogEntry): string {
    const channel = entry.channelName ?? "Unknown channel";
    if (!entry.guildId) return channel;
    return `#${channel} · ${entry.guildName ?? "Unknown server"}`;
}

function withFlags(text: string, flags?: string[]): string {
    return flags?.length ? `${text} (${flags.join(", ")})` : text;
}

function channelMention(name?: string): string {
    return name ? `#${name}` : "another channel";
}

export function describeEntry(entry: VoiceChannelLogEntry): string {
    switch (entry.type) {
        case "join":
            return withFlags("Joined the channel", entry.flags);
        case "leave":
            return "Left the channel";
        case "present":
            return withFlags("Already in the channel", entry.flags);
        case "move":
            return entry.channelId === entry.oldChannelId
                ? `Moved to ${channelMention(entry.newChannelName)}`
                : `Moved from ${channelMention(entry.oldChannelName)}`;
        case "soundboard":
            return "Played a soundboard sound";
        case "self_mute":
            return entry.enabled ? "Muted" : "Unmuted";
        case "self_deafen":
            return entry.enabled ? "Deafened" : "Undeafened";
        case "server_mute":
            return entry.enabled ? "Server muted" : "Server unmuted";
        case "server_deafen":
            return entry.enabled ? "Server deafened" : "Server undeafened";
        case "self_video":
            return entry.enabled ? "Turned on camera" : "Turned off camera";
        case "self_stream":
            return entry.enabled ? "Started screensharing" : "Stopped screensharing";
        case "activity":
            return `Started ${entry.activityName ?? "an activity"}`;
        case "activity_stop":
            return `Stopped ${entry.activityName ?? "an activity"}`;
    }
}

/** Matching logs, newest first. */
export function filterEntries(entries: VoiceChannelLogEntry[], { channelId, group, query }: LogFilter): VoiceChannelLogEntry[] {
    const search = query.trim().toLowerCase();

    return entries.filter(entry => {
        if (channelId && entry.channelId !== channelId) return false;
        if (group !== "all" && GROUP_BY_TYPE[entry.type] !== group) return false;
        if (!search) return true;

        return [entry.displayName, entry.username, entry.userId, entry.channelName, entry.guildName, describeEntry(entry)]
            .some(text => text?.toLowerCase().includes(search));
    }).reverse();
}

export function listChannels(entries: VoiceChannelLogEntry[]): { label: string; value: string; }[] {
    const channels = new Map<string, string>();
    for (const entry of entries) channels.set(entry.channelId, getChannelLabel(entry));

    return [...channels]
        .map(([value, label]) => ({ label, value }))
        .sort((a, b) => a.label.localeCompare(b.label));
}

export function toExportRecord(entry: VoiceChannelLogEntry) {
    return {
        time: entry.timestamp.toISOString(),
        event: entry.type,
        description: describeEntry(entry),
        user: getUserLabel(entry),
        username: entry.username,
        userId: entry.userId,
        channel: entry.channelName,
        channelId: entry.channelId,
        server: entry.guildName,
        serverId: entry.guildId,
        callStartedAt: entry.callStartedAt ? new Date(entry.callStartedAt).toISOString() : undefined
    };
}
