/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { createStore, del, getMany, keys, set, UseStore } from "@api/DataStore";
import { debounce } from "@shared/debounce";
import { Logger } from "@utils/Logger";
import { PluginNative } from "@utils/types";

import { createHistoryStore } from "./history";
import settings from "./settings";
import { VoiceChannelLogEntry } from "./types";

const logger = new Logger("VoiceChannelLog");

let dataStore: UseStore | undefined;
const getDataStore = () => dataStore ??= createStore("VoiceChannelLog", "History");

const history = createHistoryStore({
    keys: () => keys<string>(getDataStore()),
    getMany: bucketKeys => getMany(bucketKeys, getDataStore()),
    set: (key, value) => set(key, value, getDataStore()),
    del: key => del(key, getDataStore())
}, {
    shouldPersist: () => settings.store.persistHistory,
    retentionDays: () => settings.store.deleteAfterDays,
    onError: (message, error) => logger.error(message, error)
});

const scheduleSave = debounce(() => void history.flush(), 2000);

export const { open: openHistory, getEntries: getVcLogs, clear: clearLogs, subscribe: vcLogSubscribe } = history;

export function archiveHistory() {
    if (!IS_DISCORD_DESKTOP || !settings.store.autoArchive) return;

    const Native = VencordNative.pluginHelpers.VoiceChannelLog as PluginNative<typeof import("./native")>;
    return history.archive((day, content, accountId) => Native.writeArchive(accountId, day, content));
}

export function flushHistory() {
    return history.flush();
}

export function addLogEntry(entry: VoiceChannelLogEntry) {
    history.add(entry);
    scheduleSave();
}
