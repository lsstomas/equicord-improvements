/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { createStore, del, get, getMany, keys, set, UseStore } from "@api/DataStore";
import { PluginNative } from "@utils/types";

import { createDayStore } from "../../equicordplugins/voiceChannelLog/dayStore";
import { PreviousVoiceState } from "../../equicordplugins/voiceChannelLog/types";
import { ProfileSnapshot } from "./profileTracking";
import { ActivityLog } from "./types";

const STORE_KEY = "ActivityTracker_data";
const HISTORY_ACCOUNT = "logs";
const RECENT_DAYS = 90;
const SAVE_DELAY_MS = 2000;

interface SavedData {
    trackedUsers: string[];
    /** Only in data saved before logs moved to the day store. */
    activityLogs?: ActivityLog[];
    lastStatuses: Record<string, string>;
    voiceStates?: Record<string, PreviousVoiceState>;
    profiles?: Record<string, ProfileSnapshot>;
}

let historyDb: UseStore | undefined;
const getHistoryDb = () => historyDb ??= createStore("ActivityTracker", "History");

export const history = createDayStore<ActivityLog>({
    keys: () => keys<string>(getHistoryDb()),
    getMany: bucketKeys => getMany(bucketKeys, getHistoryDb()),
    set: (key, value) => set(key, value, getHistoryDb()),
    del: key => del(key, getHistoryDb())
}, {
    getTime: log => new Date(log.timestamp),
    revive: raw => {
        const log = raw as ActivityLog | undefined;
        return typeof log?.timestamp === "number" && typeof log.userId === "string" ? log : null;
    },
    shouldPersist: () => true,
    retentionDays: () => 0,
    recentDays: () => RECENT_DAYS,
    onError: (message, error) => console.error(`[ActivityTracker] ${message}:`, error)
});

export const trackedUserIds = new Set<string>();
export const lastKnownStatus = new Map<string, string>();
export const voiceBaseline = new Map<string, PreviousVoiceState>();
export const profiles = new Map<string, ProfileSnapshot>();

/** Last known message of each tracked person, because Discord's delete event doesn't say who wrote it. */
export const knownMessages = new Map<string, { userId: string; username: string; content: string; }>();

let saveTimer: ReturnType<typeof setTimeout> | undefined;
let trackedListeners: (() => void)[] = [];

function rememberMessage(log: ActivityLog) {
    const id = log.message?.id;
    if (id) knownMessages.set(id, { userId: log.userId, username: log.username, content: log.message!.content });
}

export async function loadState() {
    const saved = await get<SavedData>(STORE_KEY);

    await history.open(HISTORY_ACCOUNT);
    history.getEntries().forEach(rememberMessage);

    if (!saved) return;

    saved.trackedUsers.forEach(id => trackedUserIds.add(id));
    Object.entries(saved.lastStatuses).forEach(([id, status]) => lastKnownStatus.set(id, status));
    Object.entries(saved.voiceStates ?? {}).forEach(([id, state]) => voiceBaseline.set(id, state));
    Object.entries(saved.profiles ?? {}).forEach(([id, profile]) => profiles.set(id, profile));
    trackedListeners.forEach(listener => listener());

    if (saved.activityLogs) {
        saved.activityLogs.forEach(log => history.add(log));
        await history.flush();
        saveNow();
    }
}

export function saveNow() {
    clearTimeout(saveTimer);
    saveTimer = undefined;

    set(STORE_KEY, {
        trackedUsers: [...trackedUserIds],
        lastStatuses: Object.fromEntries(lastKnownStatus),
        voiceStates: Object.fromEntries(voiceBaseline),
        profiles: Object.fromEntries(profiles)
    } satisfies SavedData).catch(error => console.error("[ActivityTracker] Failed to save data:", error));

    void history.flush();
}

export function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, SAVE_DELAY_MS);
}

export function flushSave() {
    if (saveTimer) saveNow();
}

export function addLog(log: ActivityLog) {
    history.add(log);
    rememberMessage(log);
    scheduleSave();
}

export function setTracked(userId: string, tracked: boolean) {
    if (tracked) {
        trackedUserIds.add(userId);
    } else {
        trackedUserIds.delete(userId);
        voiceBaseline.delete(userId);
    }

    trackedListeners.forEach(listener => listener());
    saveNow();
}

export function subscribeTracked(listener: () => void) {
    trackedListeners = [...trackedListeners, listener];
    return () => {
        trackedListeners = trackedListeners.filter(l => l !== listener);
    };
}

export async function clearAll() {
    await history.clear();
    knownMessages.clear();
    trackedUserIds.clear();
    lastKnownStatus.clear();
    voiceBaseline.clear();
    profiles.clear();
    trackedListeners.forEach(listener => listener());
    saveNow();
}

const getNative = () => VencordNative.pluginHelpers.ActivityTracker as PluginNative<typeof import("./native")>;

export function archiveHistory() {
    if (!IS_DISCORD_DESKTOP) return;
    return history.archive((day, content, accountId) => getNative().writeArchive(accountId, day, content));
}

export function saveProfileImage(userId: string, kind: "avatar" | "banner", hash: string, url: string) {
    if (!IS_DISCORD_DESKTOP) return;
    getNative().saveImage(userId, kind, hash, url).catch(error => console.error("[ActivityTracker] Failed to save image:", error));
}
