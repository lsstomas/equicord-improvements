/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

async function load(path) {
    const result = await build({
        entryPoints: [fileURLToPath(new URL(`../src/userplugins/${path}`, import.meta.url))],
        bundle: true, write: false, format: "cjs", platform: "node"
    });
    const module = { exports: {} };
    new Function("module", "exports", result.outputFiles[0].text)(module, module.exports);
    return module.exports;
}

const { describeSignals, getMessageSignals, hasProfileThemeCode } = await load("clientModDetector/signals.ts");

// The exact links FakeNitro builds: src/plugins/fakeNitro/index.tsx.
const emojiLink = "https://cdn.discordapp.com/emojis/123456789012345678.webp?size=48&name=wow&lossless=true";
assert.deepEqual(getMessageSignals(`look [wow](${emojiLink})`), ["fakeNitro"], "Hyperlinked emoji");
assert.deepEqual(getMessageSignals(emojiLink), ["fakeNitro"], "Bare emoji link");
assert.deepEqual(getMessageSignals("https://media.discordapp.net/stickers/123456789012345678.png?size=160&name=cat&lossless=true"), ["fakeNitro"]);

assert.deepEqual(getMessageSignals("https://cdn.discordapp.com/emojis/123456789012345678.webp?size=48"), [], "A copied emoji link is not FakeNitro");
assert.deepEqual(getMessageSignals("hello there <:wow:123456789012345678>"), [], "A real emoji is not a sign");
assert.deepEqual(getMessageSignals(undefined), []);
assert.deepEqual(getMessageSignals("👨\u200d👩\u200d👧 family"), [], "Emoji joiners must not look like InvisibleChat");
assert.deepEqual(getMessageSignals("cover \u200c\u2061text"), ["invisibleChat"]);

const encode = text => [...text].map(char => String.fromCodePoint(char.codePointAt(0) + 0xe0000)).join("");
assert.equal(hasProfileThemeCode(`my bio ${encode("[#ff0000,#00ff00]")}`), true, "Profile theme code");
assert.equal(hasProfileThemeCode("my bio [#ff0000,#00ff00]"), false, "Visible text is not hidden code");
assert.equal(hasProfileThemeCode(`bio ${encode("hello")}`), false);
assert.equal(hasProfileThemeCode(undefined), false);
assert.match(describeSignals(["usrbg", "fakeNitro"]), /USRBG.*FakeNitro/);

const { getContactChanges, getTrackedVoiceUpdate } = await load("activityTracker/voiceTracking.ts");
const stats = await load("activityTracker/stats.ts");
const { buildDayRows, computeContacts, formatDuration, getBusiestHour, logsSince, pairVoiceSessions } = stats;
const { getInsights } = await load("activityTracker/insights.ts");
const { sortPeople } = await load("activityTracker/people.ts");
const { createChatTracker } = await load("activityTracker/chatTracking.ts");
const { imageUrl, mergeProfile } = await load("activityTracker/profileTracking.ts");
const { describeLog, describePlace, getMessageLink } = await load("activityTracker/describe.ts");

const voice = overrides => ({ mute: false, deaf: false, selfMute: false, selfDeaf: false, selfVideo: false, selfStream: false, channelId: "a", ...overrides });

// The bug this replaces: every state change in a call was logged as a move, which opened a new session.
assert.deepEqual(getTrackedVoiceUpdate(voice(), voice({ selfMute: true }), "a"), {
    action: null,
    changes: [{ type: "self_mute", channelId: "a", enabled: true }]
}, "Muting is not a move");

assert.equal(getTrackedVoiceUpdate(undefined, voice(), undefined).action, "join");
assert.equal(getTrackedVoiceUpdate(voice(), voice({ channelId: undefined }), "a").action, "leave");
assert.equal(getTrackedVoiceUpdate(voice(), voice({ channelId: "b" }), "a").action, "move");
assert.equal(getTrackedVoiceUpdate(undefined, voice({ channelId: "b" }), "a").action, "move");
assert.deepEqual(getTrackedVoiceUpdate(undefined, voice(), "a"), { action: null, changes: [] }, "An unknown user has nothing to compare");
assert.deepEqual(getTrackedVoiceUpdate(voice(), voice(), "a").changes, [], "A repeated state is not a change");

const stream = getTrackedVoiceUpdate(voice({ selfVideo: true }), voice({ selfStream: true }), "a");
assert.deepEqual(stream.changes.map(change => [change.type, change.enabled]), [["self_video", false], ["self_stream", true]]);

const channels = [["t1", "a"], ["t2", "b"], ["t3", undefined]];
assert.deepEqual(getContactChanges(channels, "x", null, "a"), [{ trackedId: "t1", action: "joined", channelId: "a" }]);
assert.deepEqual(getContactChanges(channels, "x", "a", "b").map(change => [change.trackedId, change.action]), [["t1", "left"], ["t2", "joined"]]);
assert.deepEqual(getContactChanges(channels, "t1", null, "a"), [], "Nobody is their own contact");
assert.deepEqual(getContactChanges(channels, "x", "a", "a"), [], "Muting is not arriving");
assert.deepEqual(getContactChanges(channels, "x", "z", "y"), []);

const peer = (id, name = id) => ({ id, name });
const contacts = computeContacts([
    { timestamp: 0, type: "voice", voiceChannel: { action: "join", present: [peer("ana")] } },
    { timestamp: 10, type: "contact", contact: { action: "joined", userId: "bob", name: "bob" } },
    { timestamp: 30, type: "contact", contact: { action: "left", userId: "bob", name: "bob" } },
    { timestamp: 50, type: "voice", voiceChannel: { action: "move", present: [peer("cid")] } },
    { timestamp: 60, type: "voice", voiceChannel: { action: "leave" } },
    { timestamp: 70, type: "voice", voiceChannel: { action: "join", present: [peer("ana")] } },
    { timestamp: 75, type: "chat", chat: { userId: "bob", name: "bob", startedAt: 0, endedAt: 500, turns: 6 } },
    { timestamp: 80, type: "chat", chat: { userId: "bob", name: "bob", startedAt: 0, endedAt: 100, turns: 4 } }
], 100);
assert.deepEqual(contacts.map(contact => [contact.id, contact.callMs, contact.chatMs, contact.turns]), [
    ["bob", 20, 600, 10],
    ["ana", 80, 0, 0],
    ["cid", 10, 0, 0]
], "Calls and conversations add up, longest first");
assert.deepEqual(computeContacts([]), []);

// Sessions, including logs saved while the move bug existed.
const entries = pairVoiceSessions([
    { userId: "u", timestamp: 0, type: "voice", voiceChannel: { action: "join", channelId: "a", channelName: "a" } },
    { userId: "u", timestamp: 10, type: "voice", voiceChannel: { action: "move", channelId: "a", channelName: "a" } },
    { userId: "u", timestamp: 20, type: "message", message: { content: "x" } },
    { userId: "u", timestamp: 30, type: "voice", voiceChannel: { action: "move", channelId: "b", channelName: "b" } },
    { userId: "u", timestamp: 40, type: "voice", voiceChannel: { action: "leave", channelId: "b", channelName: "b", detected: true } },
    { userId: "u", timestamp: 50, type: "voice", voiceChannel: { action: "join", channelId: "c", channelName: "c" } }
], 80);
const sessions = entries.filter(entry => entry.kind === "session").map(entry => entry.session);
assert.deepEqual(sessions.map(session => [session.place.channelId, session.durationMs, session.endedAt]), [["a", 30, 30], ["b", 10, 40], ["c", 30, null]], "A same-channel move must not split a session");
assert.equal(sessions[1].approximate, true, "A noticed leave is approximate");
assert.equal(entries.length, 4);

const today = new Date(2026, 10, 1, 12).getTime();
const midnight = new Date(2026, 10, 1).getTime();
const rows = buildDayRows(
    [{ type: "message", timestamp: midnight + 6 * 3600000 }, { type: "status", timestamp: midnight + 7 * 3600000 }],
    [{ startedAt: midnight - 3600000, endedAt: midnight + 3600000, durationMs: 0, place: { channelName: "late" } }],
    2, today
);
assert.equal(rows.length, 2);
assert.equal(rows[0].messages.length, 1, "Only messages become ticks");
assert.equal(rows[0].messages[0], 0.25);
assert.equal(rows[0].calls[0].start, 0, "A call over midnight must be cut at the day's edge");
assert.ok(Math.abs(rows[1].calls[0].end - 1) < 1e-9);
assert.equal(rows[0].date.getDate(), 1, "Newest day first");

assert.equal(logsSince([{ timestamp: 0 }, { timestamp: 999 }], null, 1000).length, 2);
assert.equal(logsSince([{ timestamp: 0 }, { timestamp: 86400000 + 5 }], 1, 86400000 + 10).length, 1);
assert.equal(getBusiestHour([]), null);
assert.equal(formatDuration(30000), "under 1m");
assert.equal(formatDuration(3660000), "1h 1m");
assert.equal(formatDuration(3600000), "1h");

// Conversations: repeated back and forth counts, and being in the same room doesn't.
{
    const found = [];
    const chats = createChatTracker({ gapMs: 100, minTurns: 4, isTracked: id => id === "t", onSession: session => found.push(session) });
    const T = { id: "t", name: "t" }, B = { id: "b", name: "b" }, C = { id: "c", name: "c" };

    chats.observe("c1", T, 0);
    chats.observe("c1", B, 10);
    chats.observe("c1", T, 20);
    chats.observe("c1", B, 30);
    chats.observe("c1", B, 35);
    chats.observe("c1", T, 40);
    chats.sweep(50);
    assert.equal(found.length, 0, "A conversation in progress isn't finished");
    chats.sweep(1000);
    assert.equal(found.length, 1);
    assert.equal(found[0].otherId, "b");
    assert.equal(found[0].startedAt, 0);
    assert.equal(found[0].endedAt, 40);
    assert.equal(found[0].turns, 5, "Consecutive messages from one person are one turn");

    found.length = 0;
    chats.observe("c2", T, 2000);
    chats.observe("c2", B, 2010);
    chats.sweep(5000);
    assert.equal(found.length, 0, "One exchange is not a conversation");

    chats.observe("c3", T, 6000);
    chats.observe("c3", B, 6500);
    chats.observe("c3", T, 7000);
    chats.observe("c3", B, 7500);
    chats.sweep(9000);
    assert.equal(found.length, 0, "Messages far apart are not a conversation");

    chats.observe("c4", B, 10000);
    chats.observe("c4", C, 10010);
    chats.observe("c4", B, 10020);
    chats.observe("c4", C, 10030);
    chats.sweep(20000);
    assert.equal(found.length, 0, "Two untracked people are ignored");

    chats.observe("c5", T, 30000);
    chats.observe("c5", B, 30010, ["t"]);
    chats.observe("c5", T, 30020, ["b"]);
    chats.sweep(Infinity);
    assert.equal(found.length, 1, "Replies and mentions count double");
}

// Profile versions.
{
    const first = mergeProfile(undefined, { username: "ana", avatar: "aaa", bio: undefined, nicks: { g: "an" } });
    assert.deepEqual(first.changes, [], "The first snapshot has nothing to compare");

    const same = mergeProfile(first.snapshot, { username: "ana", avatar: "aaa", bio: undefined, nicks: { g: "an" } });
    assert.deepEqual(same.changes, []);

    const unknown = mergeProfile({ ...first.snapshot, bio: "hello" }, { username: "ana", bio: undefined });
    assert.deepEqual(unknown.changes, [], "An unknown bio is not a removed bio");
    assert.equal(unknown.snapshot.bio, "hello");

    const firstBio = mergeProfile(first.snapshot, { bio: "hello" });
    assert.deepEqual(firstBio.changes, [], "Learning a value for the first time is not a change");
    assert.equal(firstBio.snapshot.bio, "hello");

    const changed = mergeProfile(firstBio.snapshot, { username: "ana2", avatar: "bbb", bio: "bye", nicks: { g: "ana" } });
    assert.deepEqual(changed.changes.map(change => [change.field, change.before, change.after]), [
        ["username", "ana", "ana2"], ["avatar", "aaa", "bbb"], ["bio", "hello", "bye"], ["nick", "an", "ana"]
    ]);
    assert.equal(changed.changes[3].guildId, "g");

    assert.deepEqual(mergeProfile({ globalName: "x" }, { globalName: null }).changes.map(change => change.after), [undefined], "Removing a value is a change");
    assert.deepEqual(mergeProfile({ bio: "" }, { bio: null }).changes, [], "Empty and null are the same");

    assert.equal(imageUrl("avatar", "1", "abc"), "https://cdn.discordapp.com/avatars/1/abc.png?size=512");
    assert.equal(imageUrl("banner", "1", "a_abc", 160), "https://cdn.discordapp.com/banners/1/a_abc.gif?size=160");
}

assert.equal(describeLog({ type: "reaction", reaction: { added: true, emoji: "x", targetAuthor: "bob" } }), "Reacted x on bob's message");
assert.equal(describeLog({ type: "messageDelete", messageDelete: {} }), "Deleted a message");
assert.equal(describeLog({ type: "message", message: { content: "", attachments: 2 } }), "Sent 2 attachments");
assert.equal(getMessageLink({ message: { id: "m", channelId: "c" } }), "/channels/@me/c/m");
assert.equal(getMessageLink({ messageEdit: { id: "m", channelId: "c", guildId: "g" } }), "/channels/g/c/m");
assert.equal(getMessageLink({ messageDelete: { id: "m", channelId: "c" } }), undefined, "A deleted message has nothing to open");

// Time in each status and game.
{
    const { buildActivitySpans, buildStatusSpans, clipSpans, getBusiestWindow, hourlyActivity, percentChange, previousPeriod, rankChannels, rankEmojis, rankPlatforms, spansSince, sumSpans } = stats;
    const status = (timestamp, value, clientStatus) => ({ type: "status", timestamp, status: { status: value, clientStatus } });
    const activity = (timestamp, ...activities) => ({ type: "activity", timestamp, activities });

    const spans = buildStatusSpans([status(10, "online"), { type: "message", timestamp: 15 }, status(30, "idle"), status(40, "offline")], 100);
    assert.deepEqual(spans.map(span => [span.label, span.start, span.end]), [["online", 10, 30], ["idle", 30, 40], ["offline", 40, 100]]);
    assert.deepEqual(sumSpans(spans).map(total => [total.label, total.durationMs]), [["offline", 60], ["online", 20], ["idle", 10]]);

    // The 296 hours bug: a week must not count time from before that week.
    const DAY = 86400000;
    const old = spansSince([{ label: "online", start: 0, end: 30 * DAY }], 7, 30 * DAY);
    assert.equal(sumSpans(old)[0].durationMs, 7 * DAY, "Totals must stay inside the period");
    assert.deepEqual(spansSince([{ label: "x", start: 0, end: DAY }], 7, 30 * DAY), [], "Spans before the period are left out");
    assert.equal(spansSince(spans, null).length, 3);

    const games = buildActivitySpans([
        activity(10, { name: "Game", type: 0 }, { name: "Custom Status", type: 4 }),
        activity(20, { name: "Game", type: 0 }, { name: "Spotify", type: 2 }),
        activity(30, { name: "Spotify", type: 2 }),
        status(40, "offline"),
        activity(50, { name: "Other", type: 0 })
    ], 100);
    assert.deepEqual(games.map(span => [span.label, span.start, span.end]), [["Game", 10, 30], ["Spotify", 20, 40], ["Other", 50, 100]], "A custom status isn't a game, and offline ends everything");

    assert.deepEqual(clipSpans([{ label: "a", start: 50, end: 150 }, { label: "b", start: 200, end: 300 }], 100, 200).map(span => [span.from, span.to]), [[0, 0.5]]);

    const start = new Date(2026, 10, 1, 10, 30).getTime();
    const hours = hourlyActivity(
        [{ type: "message", timestamp: start }, { type: "status", timestamp: start }],
        [{ startedAt: start, endedAt: start + 3600000, durationMs: 3600000 }]
    );
    assert.equal(hours[10].messages, 1);
    assert.equal(hours[10].callMs, 1800000, "A call must split across hours");
    assert.equal(hours[11].callMs, 1800000);

    const place = channelId => ({ channelId, channelName: channelId, guildName: "g" });
    assert.deepEqual(rankChannels([{ message: place("a") }, { message: place("b") }, { message: place("b") }, {}]).map(channel => [channel.label, channel.count]), [["b", 2], ["a", 1]]);
    assert.deepEqual(rankEmojis([{ reaction: { added: true, emoji: "x" } }, { reaction: { added: false, emoji: "y" } }]), [{ emoji: "x", count: 1 }], "Removed reactions don't count");
    assert.deepEqual(rankPlatforms([status(1, "online", { desktop: "online", mobile: "idle" }), status(2, "idle", { desktop: "idle" })]).map(item => item.label), ["desktop", "mobile"]);

    const logs = [{ timestamp: 5 * DAY }, { timestamp: 9 * DAY }, { timestamp: 12 * DAY }];
    assert.deepEqual(previousPeriod(logs, 3, 12 * DAY + 1).map(log => log.timestamp), [9 * DAY], "The period just before the current one");
    assert.equal(previousPeriod(logs, null), null, "All time has nothing before it");
    assert.equal(percentChange(150, 100), 50);
    assert.equal(percentChange(5, 0), null, "Nothing to compare with");

    const at = hour => ({ timestamp: new Date(2026, 10, 1, hour).getTime() });
    assert.equal(getBusiestWindow([at(23), at(23), at(0), at(1), at(12)]), 23, "The window can cross midnight");
    assert.equal(getBusiestWindow([]), null);

    const base = { logs: [], previous: null, sessions: [], contacts: [], games: [], onlineMs: 0, days: 7 };
    assert.deepEqual(getInsights(base), [], "No data means no claims");

    const messages = count => Array.from({ length: count }, (_, index) => ({ type: "message", timestamp: new Date(2026, 10, 1, 20, index).getTime(), message: place("geral") }));
    const insights = getInsights({ ...base, logs: messages(12), previous: messages(8) });
    assert.ok(insights.includes("Sent 50% more messages than the previous 7 days"));
    assert.ok(insights.includes("Most active between 20:00 and 23:00") || insights.some(text => text.startsWith("Most active")));
    assert.ok(insights.includes("100% of messages were in #geral"));

    assert.equal(getInsights({ ...base, logs: messages(12), previous: messages(2) }).some(text => text.startsWith("Sent")), false, "Too little to compare");
    assert.equal(getInsights({ ...base, logs: messages(3) }).length, 0, "One or two events aren't a pattern");

    const close = { id: "a", name: "ana", callMs: 3600000, chatMs: 0, turns: 0, calls: 1, lastAt: 1 };
    const far = { id: "b", name: "bob", callMs: 1200000, chatMs: 0, turns: 0, calls: 1, lastAt: 1 };
    assert.ok(getInsights({ ...base, contacts: [close, far] }).includes("75% of time with others was with ana"));
    assert.equal(getInsights({ ...base, contacts: [close] }).length, 0, "One contact is always 100%");
    assert.ok(getInsights({ ...base, onlineMs: 7 * 3600000 }).includes("Online about 1h a day"));
}

// Sidebar order.
{
    const person = (id, name, status, inCall, lastAt, addedIndex) => ({ id, name, status, inCall, lastAt, addedIndex });
    const people = [
        person("a", "Zed", "offline", false, 50, 0),
        person("b", "ana", "online", false, 10, 1),
        person("c", "Bia", "idle", true, 20, 2),
        person("d", "Caio", "dnd", false, 30, 3),
        person("e", "Duda", "online", false, 40, 4)
    ];
    const order = sort => sortPeople(people, sort).map(item => item.id).join("");

    assert.equal(order("activity"), "aedcb");
    assert.equal(order("status"), "cebda", "In a call first, then by status, then latest activity");
    assert.equal(order("name"), "bcdea", "Names ignore case");
    assert.equal(order("added"), "edcba", "Newest first");
    assert.equal(order("unknown"), "aedcb", "An old saved value falls back");
    sortPeople(people, "name");
    assert.equal(people.map(item => item.id).join(""), "abcde", "Sorting must not change the original list");
}

// Places saved by older versions.
assert.equal(describePlace({ channelName: "Channel ID: 111", guildName: "DM" }), "Direct message");
assert.equal(describePlace({ channelName: "geral", guildName: "the boys" }), "#geral in the boys");
assert.equal(describePlace({ channelName: "Channel ID: 111", guildName: "the boys" }), "Unknown channel in the boys");
assert.equal(describePlace({ channelName: "Direct message" }), "Direct message");

console.log("Userplugin tests passed.");
