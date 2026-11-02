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
const { describeEntry, filterEntries, getDayKey, reviveEntry, toExportRecord } = history;
const { CHUNK_SIZE, createLogStore, decodeChunk, encodeChunk } = await load("logStore.ts");

const entryAt = (timestamp, overrides = {}) => ({ id: String(timestamp), type: "join", userId: "u1", channelId: "c1", timestamp: new Date(timestamp), ...overrides });
globalThis.IS_DISCORD_DESKTOP = false;
const DAY_MS = 86_400_000;
const FILTER = { channelId: null, group: "all", query: "" };

const openStore = (storage, overrides = {}) => createLogStore(storage, {
    shouldPersist: () => true,
    retentionDays: () => 0,
    onError(message, error) { throw error ?? new Error(message); },
    ...overrides
});
const chunkKeys = storage => [...storage.data.keys()].filter(key => key.startsWith("v2:"));

function countingStorage() {
    const storage = memoryStorage();
    const counts = { keys: 0, getMany: 0, set: 0 };
    const { keys, getMany, set } = storage;
    storage.keys = function () { counts.keys++; return keys.call(this); };
    storage.getMany = function (list) { counts.getMany++; return getMany.call(this, list); };
    storage.set = function (key, value) { counts.set++; return set.call(this, key, value); };
    return { storage, counts };
}

// The compact format must give back everything the log shows, and nothing may be lost in between.
{
    const base = Date.now();
    // A user or channel keeps one name inside a chunk, as it does in a real call.
    const ana = { username: "ana", displayName: "Ana", avatar: "hash" };
    const bob = { username: "bob" };
    const general = { guildId: "g", guildName: "Friends", channelName: "general" };
    const entries = [
        entryAt(base, { id: "a", callStartedAt: base - 5000, ...ana, ...general, flags: ["muted", "camera on"] }),
        entryAt(base + 1, { id: "b", type: "self_mute", enabled: false, userId: "u2", ...bob, ...general, callStartedAt: base - 5000 }),
        entryAt(base + 2, { id: "c", type: "self_video", enabled: true, channelId: "c2", ...ana }),
        entryAt(base + 3, { id: "d", type: "move", ...ana, ...general, oldChannelId: "c1", oldChannelName: "general", newChannelId: "c2", newChannelName: "games" }),
        entryAt(base + 4, { id: "e", type: "soundboard", ...ana, ...general, soundId: "s", emoji: { name: "x", animated: false } }),
        entryAt(base + 5, { id: "f", type: "activity", ...ana, ...general, activityName: "Chess", applicationId: "app" }),
        entryAt(base + 6, { id: "g", ...ana, ...general, flags: [] })
    ];
    const decoded = decodeChunk(structuredClone(encodeChunk(entries)), "k");

    assert.equal(decoded.length, entries.length);
    decoded.forEach((entry, index) => {
        const { id, ...rest } = entries[index];
        assert.deepEqual({ ...entry, id: undefined }, { ...rest, id: undefined }, `Entry ${id} must survive the format`);
    });
    assert.equal(new Set(decoded.map(entry => entry.id)).size, entries.length, "Rows need unique keys");

    // The whole point: repeated names are stored once.
    const many = Array.from({ length: CHUNK_SIZE }, (_, index) => entryAt(base + index, { id: String(index), type: "self_mute", enabled: index % 2 === 0, callStartedAt: base, guildId: "123456789012345678", guildName: "Friends", channelName: "general", username: "ana", displayName: "Ana", avatar: "a".repeat(32) }));
    const chunk = encodeChunk(many);
    assert.equal(chunk.users.length, 1);
    assert.equal(chunk.channels.length, 1);
    assert.equal(chunk.calls.length, 1);
    assert.ok(chunk.time instanceof Float64Array && chunk.kind instanceof Uint8Array, "Columns must clone as raw memory");
}

// Opening Discord must not read anything: that read was the freeze.
{
    const { storage, counts } = countingStorage();
    const seed = openStore(storage);
    seed.open("me");
    for (let index = 0; index < 1200; index++) seed.add(entryAt(Date.now() + index, { id: `e${index}` }));
    await seed.flush();

    const baseline = { ...counts };
    const store = openStore(storage);
    await Promise.all([store.open("me"), store.open("me")]);
    assert.deepEqual(counts, baseline, "Opening must not touch storage");

    store.add(entryAt(Date.now(), { id: "next" }));
    assert.deepEqual(counts, baseline, "Recording must not touch storage until the next save");
}

// A restart brings logs back through the page, split by day and into chunks of a fixed size.
{
    const storage = memoryStorage();
    const first = openStore(storage);
    first.open("me");
    first.add(entryAt(Date.now() - DAY_MS, { id: "yesterday" }));
    for (let index = 0; index < CHUNK_SIZE + 1; index++) first.add(entryAt(Date.now() + index, { id: `t${index}` }));
    await first.flush();
    assert.equal(chunkKeys(storage).length, 3, "One chunk for yesterday and two for today");
    assert.equal(new Set(chunkKeys(storage).map(key => key.split(":")[2])).size, 2, "Keys must carry the day");

    const second = openStore(storage);
    second.open("me");
    const { entries, hasMore } = await second.page(FILTER, 2000);
    assert.equal(entries.length, CHUNK_SIZE + 2);
    assert.equal(hasMore, false);
    assert.ok(entries[0].timestamp instanceof Date);
    assert.ok(entries[0].timestamp > entries.at(-1).timestamp, "Newest first");
}

// Saving must only write what's new, never the day again.
{
    const { storage, counts } = countingStorage();
    const store = openStore(storage);
    store.open("me");
    store.add(entryAt(Date.now(), { id: "one" }));
    await store.flush();
    const written = counts.set;
    const chunks = chunkKeys(storage).length;

    store.add(entryAt(Date.now() + 1, { id: "two" }));
    await store.flush();
    assert.equal(counts.set, written + 1, "A new event must write one record");
    assert.equal(chunkKeys(storage).length, chunks + 1);
    await store.flush();
    assert.equal(counts.set, written + 1, "Nothing new, nothing written");
}

// A page reads only as much as it shows.
{
    const { storage, counts } = countingStorage();
    const seed = openStore(storage);
    seed.open("me");
    for (let index = 0; index < CHUNK_SIZE * 40; index++) seed.add(entryAt(Date.now() + index, { id: `e${index}` }));
    await seed.flush();

    const store = openStore(storage);
    store.open("me");
    counts.getMany = 0;
    const page = await store.page(FILTER, 200);
    assert.equal(page.entries.length, 200);
    assert.equal(page.hasMore, true);
    assert.ok(counts.getMany <= 3, `One page took ${counts.getMany} reads`);

    const rows = new Set((await store.page(FILTER, CHUNK_SIZE * 3)).entries.map(entry => entry.id));
    assert.equal(rows.size, CHUNK_SIZE * 3, "Paging further must not repeat rows");
}

// Events that haven't been saved yet still show up, and a filter applies to them too.
{
    const storage = memoryStorage();
    const store = openStore(storage);
    store.open("me");
    store.add(entryAt(Date.now(), { id: "saved", channelId: "c1", channelName: "general" }));
    await store.flush();
    store.add(entryAt(Date.now() + 1, { id: "live", channelId: "c2", channelName: "games" }));

    assert.equal((await store.page(FILTER, 10)).entries.length, 2);
    assert.equal((await store.page({ ...FILTER, channelId: "c2" }, 10)).entries.length, 1);
    assert.deepEqual((await store.channels()).map(channel => channel.value).sort(), ["c1", "c2"]);
}

// Events before the account is known are kept, and written under it.
{
    const storage = memoryStorage();
    const store = openStore(storage);
    store.add(entryAt(Date.now(), { id: "early" }));
    await store.flush();
    assert.equal(storage.data.size, 0, "Nothing may be written without an account");
    store.open("me");
    await store.flush();
    assert.equal(chunkKeys(storage).length, 1);
    assert.ok(chunkKeys(storage)[0].startsWith("v2:me:"));
}

// A failed write must keep the events and try again.
{
    const storage = memoryStorage();
    const errors = [];
    const store = openStore(storage, { onError: message => errors.push(message) });
    store.open("me");
    storage.failWrites = true;
    store.add(entryAt(Date.now(), { id: "kept" }));
    await store.flush();
    assert.equal(errors.length, 1);
    assert.equal((await store.page(FILTER, 10)).entries.length, 1, "A failed write must not hide the event");
    storage.failWrites = false;
    await store.flush();
    assert.equal(chunkKeys(storage).length, 1);
    assert.equal((await store.page(FILTER, 10)).entries.length, 1, "Retrying must not duplicate it");
}

// With saving off nothing is written, and memory can't grow forever.
{
    const storage = memoryStorage();
    const store = openStore(storage, { shouldPersist: () => false });
    store.open("me");
    for (let index = 0; index < 6000; index++) store.add(entryAt(Date.now() + index, { id: `e${index}` }));
    await store.flush();
    assert.equal(storage.data.size, 0);
    assert.equal((await store.page(FILTER, 10000)).entries.length, 5000);
}

// Accounts stay separate.
{
    const storage = memoryStorage();
    const store = openStore(storage);
    store.open("me");
    store.add(entryAt(Date.now(), { id: "mine" }));
    store.open("other");
    await store.flush();
    assert.equal((await store.page(FILTER, 10)).entries.length, 0, "Another account must not see these logs");
    store.open("me");
    assert.equal((await store.page(FILTER, 10)).entries.length, 1);
}

// Clearing one channel keeps the rest of the chunk; clearing everything leaves nothing to come back.
{
    const storage = memoryStorage();
    const store = openStore(storage);
    store.open("me");
    store.add(entryAt(Date.now(), { id: "one", channelId: "c1" }));
    store.add(entryAt(Date.now() + 1, { id: "two", channelId: "c2" }));
    await store.flush();

    await store.clear("c1");
    assert.deepEqual((await store.page(FILTER, 10)).entries.map(entry => entry.channelId), ["c2"]);
    assert.deepEqual((await store.channels()).map(channel => channel.value), ["c2"]);

    storage.data.set("me:2020-01-01", [entryAt(1, { id: "legacy" })]);
    await store.clear();
    assert.equal((await store.page(FILTER, 10)).entries.length, 0);
    assert.equal([...storage.data.keys()].filter(key => key.includes("me:")).length, 0, "Clear all must remove old records too");
}

// Retention removes old days, and 0 keeps everything.
{
    const storage = memoryStorage();
    const seed = openStore(storage);
    seed.open("me");
    seed.add(entryAt(Date.now() - 100 * DAY_MS, { id: "old" }));
    seed.add(entryAt(Date.now(), { id: "recent" }));
    await seed.flush();

    await seed.prune();
    assert.equal(chunkKeys(storage).length, 2);

    const limited = openStore(storage, { retentionDays: () => 90 });
    limited.open("me");
    await limited.prune();
    assert.equal(chunkKeys(storage).length, 1, "Expired days must be deleted");
}

// Migration: the duplicated history collapses, in order, and the original stays untouched.
{
    const storage = memoryStorage();
    const now = Date.now();
    const day = getDayKey(new Date(now));
    const unique = Array.from({ length: CHUNK_SIZE + 10 }, (_, index) => ({ ...entryAt(now + index, { id: `e${index}`, channelName: "general" }), timestamp: new Date(now + index).toISOString() }));
    const duplicated = [...unique, ...unique, ...unique];
    storage.data.set(`me:${day}`, duplicated);
    storage.data.set("archive:me", { at: 1, day });

    const archived = new Map();
    const store = openStore(storage, { writeDay: async (account, archiveDay, content) => archived.set(`${account}/${archiveDay}`, content) });
    store.open("me");
    assert.equal(chunkKeys(storage).length, 0, "Opening must not migrate: only the log window may wait for it");

    const { entries } = await store.page(FILTER, 5);
    assert.equal(entries[0].id.length > 0, true);
    assert.equal(entries[0].timestamp.getTime(), now + unique.length - 1, "Newest first after migrating");
    assert.equal((await store.page(FILTER, CHUNK_SIZE * 2)).entries.length, unique.length, "Copies must be gone");
    assert.equal(storage.data.get(`me:${day}`).length, duplicated.length, "The original stays as a backup");
    assert.equal(archived.get(`me/${day}`).trim().split("\n").length, unique.length, "The archive gets the clean day");
    assert.deepEqual((await store.channels()).map(channel => channel.value), ["c1"]);

    // Interrupted or repeated, it must not run twice.
    const chunks = chunkKeys(storage).length;
    const again = openStore(storage);
    again.open("me");
    await again.page(FILTER, 5);
    assert.equal(chunkKeys(storage).length, chunks);
    assert.equal(storage.data.get("v2-meta:me").before, duplicated.length);
    assert.equal(storage.data.get("v2-meta:me").after, unique.length);
}

// A broken record must not stop a migration.
{
    assert.equal(reviveEntry(null), null);
    assert.equal(reviveEntry({ type: "join" }), null);
    const storage = memoryStorage();
    storage.data.set("me:2026-01-01", [null, { type: "join" }, "text", entryAt(Date.parse("2026-01-01T12:00:00"), { id: "good" })]);
    storage.data.set("me:not-a-day", [entryAt(1, { id: "ignored" })]);
    const store = openStore(storage);
    store.open("me");
    assert.deepEqual((await store.page(FILTER, 10)).entries.map(entry => entry.userId), ["u1"]);
    assert.equal((await store.page(FILTER, 10)).entries.length, 1);
}

// A failed read reports the error and changes nothing.
{
    const storage = memoryStorage();
    const seed = openStore(storage);
    seed.open("me");
    seed.add(entryAt(Date.now(), { id: "saved" }));
    await seed.flush();
    const before = [...storage.data.keys()];

    storage.failReads = true;
    const store = openStore(storage);
    store.open("me");
    await assert.rejects(store.page(FILTER, 10));
    assert.deepEqual([...storage.data.keys()], before);
}

// Saving new events writes them to the archive without rereading anything.
{
    const { storage, counts } = countingStorage();
    const appended = [];
    const store = openStore(storage, { appendDay: async (account, day, content) => appended.push([account, day, content]) });
    store.open("me");
    store.add(entryAt(Date.now(), { id: "one" }));
    store.add(entryAt(Date.now() + 1, { id: "two" }));
    await store.flush();
    assert.equal(appended.length, 1);
    assert.equal(appended[0][2].trim().split("\n").length, 2);
    assert.equal(JSON.parse(appended[0][2].split("\n")[0]).id, "one");
    assert.equal(counts.keys, 0, "Appending must not list storage");
}

// Plugin start and CONNECTION_OPEN both open the history. Six restarts turned 100 logs into 6463.
{
    const { createDayStore } = await load("dayStore.ts");
    const options = {
        getTime: log => new Date(log.timestamp),
        getId: log => log.id,
        revive: raw => raw,
        shouldPersist: () => true,
        retentionDays: () => 0,
        onError(message, error) { throw error; }
    };
    const now = Date.now();
    const day = `me:${getDayKey(new Date(now))}`;
    const storage = memoryStorage();
    storage.data.set(day, Array.from({ length: 100 }, (_, id) => ({ id, timestamp: now - 1000 })));

    for (let restart = 0; restart < 6; restart++) {
        const store = createDayStore(storage, options);
        await Promise.all([store.open("me"), store.open("me")]);
        store.add({ id: `new-${restart}`, timestamp: now });
        await store.flush();
    }
    assert.equal(storage.data.get(day).length, 106, "Opening twice at once must not copy the logs");

    // History that was already duplicated heals on the next save.
    storage.data.set(day, [...storage.data.get(day), ...storage.data.get(day)]);
    const healed = createDayStore(storage, options);
    await healed.open("me");
    assert.equal(healed.getEntries().length, 106, "Saved duplicates must not reach memory");
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

const logs = () => [...state.storage].filter(([key]) => key.startsWith("v2:")).flatMap(([key, chunk]) => decodeChunk(chunk, key));
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
