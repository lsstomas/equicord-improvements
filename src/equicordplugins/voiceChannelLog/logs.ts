/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { createStore, del, getMany, keys, set, UseStore } from "@api/DataStore";
import { debounce } from "@shared/debounce";
import { Logger } from "@utils/Logger";
import { PluginNative } from "@utils/types";

import { createLogStore } from "./logStore";
import settings from "./settings";
import { VoiceChannelLogEntry } from "./types";

const SAVE_DELAY_MS = 5000;

const logger = new Logger("VoiceChannelLog");

let dataStore: UseStore | undefined;
const getDataStore = () => dataStore ??= createStore("VoiceChannelLog", "History");

const getNative = () => VencordNative.pluginHelpers.VoiceChannelLog as PluginNative<typeof import("./native")>;
const archiving = () => IS_DISCORD_DESKTOP && settings.store.autoArchive;

const history = createLogStore({
    keys: () => keys<string>(getDataStore()),
    getMany: bucketKeys => getMany(bucketKeys, getDataStore()),
    set: (key, value) => set(key, value, getDataStore()),
    del: key => del(key, getDataStore())
}, {
    shouldPersist: () => settings.store.persistHistory,
    retentionDays: () => settings.store.deleteAfterDays,
    onError: (message, error) => logger.error(message, error),
    appendDay: async (account, day, content) => { if (archiving()) await getNative().appendArchive(account, day, content); },
    writeDay: async (account, day, content) => { if (archiving()) await getNative().writeArchive(account, day, content); }
});

const scheduleSave = debounce(() => void history.flush(), SAVE_DELAY_MS);

export const {
    open: openHistory,
    flush: flushHistory,
    clear: clearLogs,
    subscribe: vcLogSubscribe,
    getVersion: getVcLogVersion,
    page: readLogPage,
    all: readAllLogs,
    channels: readLogChannels,
    release: releaseLogs,
    prune: pruneHistory
} = history;

export function addLogEntry(entry: VoiceChannelLogEntry) {
    history.add(entry);
    scheduleSave();
}
