/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const pluginPath = path => fileURLToPath(new URL(`../src/equicordplugins/voiceChannelLog/${path}`, import.meta.url));

async function load(entry, stubs = {}) {
    const result = await build({
        entryPoints: [pluginPath(entry)],
        bundle: true, write: false, format: "cjs", platform: "node",
        plugins: [{
            name: "discord-test-stubs", setup(builder) {
                builder.onResolve({ filter: /^@(api|components|shared|utils|vencord|webpack)|^\.\/components\// }, args => ({ path: args.path, namespace: "stub" }));
                builder.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ contents: "module.exports = globalThis.voiceHistoryStubs;", loader: "js" }));
            }
        }]
    });

    globalThis.voiceHistoryStubs = stubs;
    const module = { exports: {} };
    new Function("module", "exports", "require", result.outputFiles[0].text)(module, module.exports, () => ({}));
    return module.exports;
}

function memoryStorage() {
    const data = new Map();
    return {
        data,
        failWrites: false,
        failReads: false,
        async keys() {
            if (this.failReads) throw new Error("read failed");
            return [...data.keys()];
        },
        async getMany(keys) { return keys.map(key => data.get(key)); },
        async set(key, value) {
            if (this.failWrites) throw new Error("write failed");
            data.set(key, structuredClone(value));
        },
        async del(key) { data.delete(key); }
    };
}

const history = await load("history.ts");
const { createHistoryStore, describeEntry, filterEntries, getDayKey, listChannels, toExportRecord } = history;

const entryAt = (timestamp, overrides = {}) => ({ id: String(timestamp), type: "join", userId: "u1", channelId: "c1", timestamp: new Date(timestamp), ...overrides });
globalThis.IS_DISCORD_DESKTOP = false;

const openStore = (storage, retention = 0, errors = []) => createHistoryStore(storage, {
    shouldPersist: () => true,
    retentionDays: () => retention,
    onError: (message, error) => errors.push([message, error])
});
const DAY_MS = 86_400_000;

// A restart must bring saved logs back, split by day.
{
    const storage = memoryStorage();
    const first = openStore(storage);
    await first.open("me");
    first.add(entryAt(Date.now() - DAY_MS));
    first.add(entryAt(Date.now()));
    await first.flush();
    assert.equal(storage.data.size, 2, "Each day must have its own record");

    const second = openStore(storage);
    await second.open("me");
    assert.equal(second.getEntries().length, 2);
    assert.ok(second.getEntries()[0].timestamp instanceof Date);
}

// Events recorded while saved logs are loading must neither be lost nor overwrite the saved day.
{
    const storage = memoryStorage();
    const seed = openStore(storage);
    await seed.open("me");
    seed.add(entryAt(Date.now() - 1000, { id: "saved" }));
    await seed.flush();

    const store = openStore(storage);
    store.add(entryAt(Date.now(), { id: "early" }));
    await store.flush();
    assert.equal(storage.data.values().next().value.length, 1, "Nothing may be written before the load");
    await store.open("me");
    assert.deepEqual(store.getEntries().map(entry => entry.id), ["saved", "early"]);
    assert.equal([...storage.data.values()][0].length, 2, "The merged day must be saved");
}

// A failed load must never replace saved logs.
{
    const storage = memoryStorage();
    const seed = openStore(storage);
    await seed.open("me");
    seed.add(entryAt(Date.now(), { id: "saved" }));
    await seed.flush();

    const errors = [];
    storage.failReads = true;
    const store = openStore(storage, 0, errors);
    await store.open("me");
    store.add(entryAt(Date.now() + 1, { id: "unsaved" }));
    await store.flush();
    assert.equal(errors.length, 1);
    assert.deepEqual([...storage.data.values()][0].map(entry => entry.id), ["saved"]);
}

// A save that fires in the middle of the load must wait, or it would replace the saved day.
{
    const storage = memoryStorage();
    const seed = openStore(storage);
    await seed.open("me");
    seed.add(entryAt(Date.now() - 1000, { id: "saved" }));
    await seed.flush();

    let finishLoad;
    const { getMany } = storage;
    storage.getMany = async function (keys) {
        await new Promise(resolve => { finishLoad = resolve; });
        return getMany.call(this, keys);
    };

    const store = openStore(storage);
    const opening = store.open("me");
    while (!finishLoad) await new Promise(resolve => setTimeout(resolve, 0));

    store.add(entryAt(Date.now(), { id: "during-load" }));
    await store.flush();
    assert.deepEqual([...storage.data.values()][0].map(entry => entry.id), ["saved"], "Nothing may be written during the load");

    finishLoad();
    await opening;
    assert.deepEqual([...storage.data.values()][0].map(entry => entry.id), ["saved", "during-load"]);
}

// A failed write must be retried.
{
    const storage = memoryStorage();
    const errors = [];
    const store = openStore(storage, 0, errors);
    await store.open("me");
    storage.failWrites = true;
    store.add(entryAt(Date.now()));
    await store.flush();
    assert.equal(storage.data.size, 0);
    assert.equal(errors.length, 1);
    storage.failWrites = false;
    await store.flush();
    assert.equal(storage.data.size, 1);
}

// Retention removes old days, and 0 keeps everything.
{
    const storage = memoryStorage();
    const seed = openStore(storage);
    await seed.open("me");
    seed.add(entryAt(Date.now() - 100 * DAY_MS, { id: "old" }));
    seed.add(entryAt(Date.now(), { id: "recent" }));
    await seed.flush();

    const keepAll = openStore(storage, 0);
    await keepAll.open("me");
    assert.equal(keepAll.getEntries().length, 2);

    const limited = openStore(storage, 90);
    await limited.open("me");
    assert.deepEqual(limited.getEntries().map(entry => entry.id), ["recent"]);
    assert.equal(storage.data.size, 1, "Expired days must be deleted");
}

// Accounts stay separate, and clearing removes the record even when saving is off.
{
    const storage = memoryStorage();
    const store = openStore(storage);
    await store.open("me");
    store.add(entryAt(Date.now(), { channelId: "c1" }));
    store.add(entryAt(Date.now(), { channelId: "c2" }));
    await store.flush();
    await store.open("other");
    assert.equal(store.getEntries().length, 0, "Another account must not see these logs");
    await store.open("me");
    assert.equal(store.getEntries().length, 2);

    await store.clear("c1");
    assert.deepEqual(store.getEntries().map(entry => entry.channelId), ["c2"]);
    await store.clear();
    assert.equal(store.getEntries().length, 0);
    assert.equal([...storage.data.keys()].filter(key => key.startsWith("me:")).length, 0);

    const off = createHistoryStore(storage, { shouldPersist: () => false, retentionDays: () => 0, onError() {} });
    await off.open("other");
    off.add(entryAt(Date.now()));
    await off.flush();
    assert.equal(storage.data.size, 0, "Saving off must not write");
}

// The shared day store, as ActivityTracker uses it.
{
    const { createDayStore } = await load("dayStore.ts");
    const options = {
        getTime: log => new Date(log.timestamp),
        revive: raw => typeof raw?.timestamp === "number" ? raw : null,
        shouldPersist: () => true,
        retentionDays: () => 0,
        recentDays: () => 90,
        onError(message, error) { throw error; }
    };
    const now = Date.now();
    const storage = memoryStorage();

    const seed = createDayStore(storage, options);
    await seed.open("logs");
    for (let i = 0; i < 15000; i++) seed.add({ id: i, timestamp: now - 1000 });
    seed.add({ id: "old", timestamp: now - 200 * DAY_MS });
    await seed.flush();
    assert.equal(seed.getEntries().length, 15001, "There is no event limit");

    const store = createDayStore(storage, options);
    await store.open("logs");
    assert.equal(store.getEntries().length, 15000, "Old days must stay out of memory");
    assert.equal(store.hasOlder(), true);

    // Saving today must not lose a day that isn't in memory.
    store.add({ id: "new", timestamp: now });
    await store.flush();
    assert.equal(storage.data.size, 2);
    await store.loadOlder();
    assert.equal(store.hasOlder(), false);
    assert.equal(store.getEntries()[0].id, "old", "Older logs must be merged in time order");

    const unloaded = createDayStore(storage, options);
    await unloaded.open("logs");
    assert.equal(unloaded.hasOlder(), true);

    const written = new Map();
    const writer = async (day, content, account) => { assert.equal(account, "logs"); written.set(day, content); };

    await unloaded.archive(writer);
    assert.equal(written.size, 2, "The first archive must include days that aren't in memory");
    const today = getDayKey(new Date(now));
    assert.equal(written.get(today).trim().split("\n").length, 15001, "One line per event");
    assert.equal(JSON.parse(written.get(today).split("\n")[0]).id, 0);

    written.clear();
    await unloaded.archive(writer);
    assert.equal(written.size, 0, "Archiving again within a week must do nothing");

    const metaKey = "archive:logs";
    const meta = storage.data.get(metaKey);
    assert.equal(meta.day, today);
    storage.data.set(metaKey, { ...meta, at: now - 8 * DAY_MS, day: getDayKey(new Date(now - DAY_MS)) });
    await unloaded.archive(writer);
    assert.deepEqual([...written.keys()], [today], "A later archive must only write new days");

    let failures = 0;
    storage.data.set(metaKey, { ...meta, at: 0 });
    const failing = createDayStore(storage, { ...options, onError: () => failures++ });
    await failing.open("logs");
    await failing.archive(async () => { throw new Error("disk full"); });
    assert.equal(failures, 1);
    assert.equal(storage.data.get(metaKey).at, 0, "A failed archive must be retried");

    await unloaded.clear();
    assert.equal(unloaded.hasOlder(), false);
    assert.deepEqual([...storage.data.keys()], [metaKey], "Clear all must remove days that aren't in memory");
    assert.equal(unloaded.getEntries().length, 0);
}

// Filters and labels.
{
    const entries = [
        entryAt(1, { displayName: "Alice", channelName: "general", guildId: "g", guildName: "Friends" }),
        entryAt(2, { type: "self_mute", enabled: true, displayName: "Bob", channelName: "general", guildId: "g", guildName: "Friends" }),
        entryAt(3, { type: "self_stream", enabled: false, displayName: "Bob", channelId: "c2", channelName: "games", guildId: "g", guildName: "Friends" })
    ];
    const ids = filter => filterEntries(entries, { channelId: null, group: "all", query: "", ...filter }).map(entry => entry.id);

    assert.deepEqual(ids({}), ["3", "2", "1"], "Newest first");
    assert.deepEqual(ids({ channelId: "c1" }), ["2", "1"]);
    assert.deepEqual(ids({ group: "voice" }), ["2"]);
    assert.deepEqual(ids({ query: "  BOB " }), ["3", "2"]);
    assert.deepEqual(ids({ query: "screensharing" }), ["3"]);
    assert.deepEqual(listChannels(entries).map(channel => channel.label), ["#games · Friends", "#general · Friends"]);

    assert.equal(getDayKey(new Date(2026, 0, 5, 23, 59)), "2026-01-05");
    assert.equal(describeEntry(entryAt(1, { type: "move", channelId: "a", oldChannelId: "a", newChannelId: "b", newChannelName: "lobby" })), "Moved to #lobby");
    assert.equal(describeEntry(entryAt(1, { type: "move", channelId: "b", oldChannelId: "a", newChannelId: "b", oldChannelName: "lobby" })), "Moved from #lobby");
    assert.equal(describeEntry(entryAt(1, { flags: ["muted"] })), "Joined the channel (muted)");

    const record = toExportRecord(entries[1]);
    assert.equal(record.time, new Date(2).toISOString());
    assert.equal(record.channel, "general");
    assert.equal(record.description, "Muted");
}

// Plugin wiring, with the Discord stores replaced by fakes.
const me = "me";
const state = { selected: null, voice: {}, blocked: new Set(), storage: new Map() };
const voiceState = (overrides = {}) => ({ mute: false, deaf: false, selfMute: false, selfDeaf: false, selfVideo: false, selfStream: false, ...overrides });
const settingsStub = {};

globalThis.window = { addEventListener() {}, removeEventListener() {} };

const plugin = (await load("index.tsx", {
    __esModule: true,
    default: definition => definition,
    definePluginSettings(definitions) {
        for (const [key, definition] of Object.entries(definitions)) settingsStub[key] = definition.default;
        return { store: settingsStub };
    },
    OptionType: {},
    ChannelType: { GUILD_VOICE: 2, GUILD_STAGE_VOICE: 13, DM: 1, GROUP_DM: 3 },
    Devs: {},
    EquicordDevs: {},
    Logger: class { error(...args) { throw new Error(args.join(" ")); } },
    Menu: {},
    findByPropsLazy: () => ({}),
    debounce: fn => fn,
    createStore: () => null,
    keys: async () => [...state.storage.keys()],
    getMany: async keys => keys.map(key => state.storage.get(key)),
    set: async (key, value) => { state.storage.set(key, value); },
    del: async key => { state.storage.delete(key); },
    ApplicationStore: {},
    ChannelStore: { getChannel: id => ({ id, name: `name-${id}`, guild_id: "guild", isDM: () => false }) },
    GuildStore: { getGuild: () => ({ name: "Friends" }) },
    RelationshipStore: { isBlocked: id => state.blocked.has(id) },
    SelectedChannelStore: { getVoiceChannelId: () => state.selected },
    UserStore: {
        getCurrentUser: () => ({ id: me }),
        getUser: id => ({ id, username: `user-${id}`, globalName: `Name ${id}`, avatar: "hash" })
    },
    VoiceStateStore: { getVoiceStatesForChannel: id => state.voice[id] ?? {} }
})).default;

const logs = () => [...state.storage.values()].flat();
const update = (userId, overrides) => plugin.flux.VOICE_STATE_UPDATES({ voiceStates: [voiceState({ userId, ...overrides })] });
const rows = () => logs().map(entry => `${entry.userId}:${entry.type}${entry.enabled === undefined ? "" : `=${entry.enabled}`}@${entry.channelId}`);
const select = (channelId, currentVoiceChannelId) => {
    state.selected = channelId;
    plugin.flux.VOICE_CHANNEL_SELECT({ channelId, currentVoiceChannelId });
};
const settle = async () => {
    for (let i = 0; i < 5; i++) await new Promise(resolve => setTimeout(resolve, 0));
};

plugin.start();
await settle();

state.voice.a = { friend: voiceState({ channelId: "a", selfMute: true }), other: voiceState({ channelId: "a" }) };
select("a", null);
await settle();
assert.deepEqual(rows(), ["me:join@a", "friend:present@a", "other:present@a"], "Joining must record who was already there");
assert.deepEqual(logs()[1].flags, ["muted"]);
assert.equal(logs()[0].channelName, "name-a");
assert.equal(logs()[0].guildName, "Friends");
assert.equal(logs()[0].displayName, "Name me");
assert.equal(typeof logs()[0].callStartedAt, "number");

// The update that arrives right after connecting must not look like the user joining.
const before = rows().length;
update("friend", { channelId: "a", oldChannelId: "a", selfMute: false });
await settle();
assert.deepEqual(rows().slice(before), ["friend:self_mute=false@a"], "The first change of a known user must be recorded");

update("other", { channelId: "a", oldChannelId: "a", selfDeaf: true, selfMute: true });
await settle();
assert.equal(rows().at(-1), "other:self_deafen=true@a", "Deafening must be one row");
assert.equal(rows().filter(row => row.startsWith("other:self_mute")).length, 0);

update("other", { channelId: "a", oldChannelId: "a", selfDeaf: false, selfMute: false });
await settle();
assert.equal(rows().at(-1), "other:self_deafen=false@a");
assert.equal(rows().filter(row => row.startsWith("other:self_mute")).length, 0);

update("other", { channelId: "a", oldChannelId: "a", selfDeaf: true, selfMute: true });
update("other", { channelId: "a", oldChannelId: "a", selfDeaf: false, selfMute: true });
await settle();
assert.equal(rows().at(-1), "other:self_deafen=false@a", "Undeafening while staying muted must be one row");
update("other", { channelId: "a", oldChannelId: "a", selfMute: false });
await settle();
assert.equal(rows().at(-1), "other:self_mute=false@a");

update("friend", { channelId: "a", oldChannelId: "a", selfStream: true });
update("friend", { channelId: "a", oldChannelId: "a", selfStream: false });
update("friend", { channelId: "a", oldChannelId: "a", selfVideo: true });
update("friend", { channelId: "a", oldChannelId: "a", mute: true, selfVideo: true });
await settle();
assert.deepEqual(rows().slice(-4), ["friend:self_stream=true@a", "friend:self_stream=false@a", "friend:self_video=true@a", "friend:server_mute=true@a"]);

const count = rows().length;
update(me, { channelId: "a", oldChannelId: "a" });
update(me, { channelId: "a", oldChannelId: "a", selfMute: true });
await settle();
assert.deepEqual(rows().slice(count), ["me:self_mute=true@a"], "Our own changes must be recorded");

const outside = rows().length;
update("stranger", { channelId: "z" });
update("stranger", { channelId: "z", oldChannelId: "z", selfMute: true });
update("stranger", { channelId: null, oldChannelId: "z" });
await settle();
assert.equal(rows().length, outside, "Channels we are not in must not be recorded");

await new Promise(resolve => setTimeout(resolve, 5100));
const arrivals = rows().length;
update("newcomer", { channelId: "a", selfMute: true });
update("mover", { channelId: "a", oldChannelId: "z" });
update("newcomer", { channelId: "a", oldChannelId: "a", selfMute: false });
update("mover", { channelId: "z", oldChannelId: "a" });
update("newcomer", { channelId: null, oldChannelId: "a" });
await settle();
assert.deepEqual(rows().slice(arrivals), [
    "newcomer:join@a",
    "mover:move@a",
    "newcomer:self_mute=false@a",
    "mover:move@a",
    "newcomer:leave@a"
]);
assert.equal(logs().find(entry => entry.userId === "newcomer").flags?.[0], "muted");
assert.equal(describeEntry(logs().filter(entry => entry.userId === "mover")[0]), "Moved from #name-z");
assert.equal(describeEntry(logs().filter(entry => entry.userId === "mover")[1]), "Moved to #name-z");

state.blocked.add("rude");
settingsStub.ignoreBlockedUsers = true;
const blocked = rows().length;
update("rude", { channelId: "a" });
await settle();
assert.equal(rows().length, blocked, "Blocked users must follow ignoreBlockedUsers");
settingsStub.ignoreBlockedUsers = false;

settingsStub.logSelfMuteDeafen = false;
const silent = rows().length;
update("friend", { channelId: "a", oldChannelId: "a", mute: true, selfVideo: true, selfMute: true });
await settle();
assert.equal(rows().length, silent, "Disabled event types must not be recorded");
settingsStub.logSelfMuteDeafen = true;

// Switching calls ourselves.
state.voice.b = { buddy: voiceState({ channelId: "b" }) };
const switching = rows().length;
select("b", "a");
await settle();
assert.deepEqual(rows().slice(switching), ["me:move@a", "me:move@b", "buddy:present@b"]);

// Being moved by a moderator never sends VOICE_CHANNEL_SELECT.
state.voice.c = {};
const forced = rows().length;
state.selected = "c";
update(me, { channelId: "c", oldChannelId: "b" });
await settle();
assert.deepEqual(rows().slice(forced), ["me:move@b", "me:move@c"]);

// Leaving ends the recording.
const leaving = rows().length;
select(null, "c");
await settle();
update("buddy", { channelId: "b", oldChannelId: "b", selfMute: true });
await settle();
assert.deepEqual(rows().slice(leaving), ["me:leave@c"]);

plugin.stop();
console.log("Voice channel history tests passed.");
