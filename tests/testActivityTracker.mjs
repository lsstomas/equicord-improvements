/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const state = { voice: {}, saved: new Map(), notifications: [], handlers: {}, names: {}, avatars: {}, profiles: {}, nicks: {}, messages: {} };
const voiceState = overrides => ({ mute: false, deaf: false, selfMute: false, selfDeaf: false, selfVideo: false, selfStream: false, ...overrides });

const stubs = {
    __esModule: true,
    default: definition => definition,
    definePluginSettings(definitions) {
        const store = Object.fromEntries(Object.entries(definitions).map(([key, definition]) => [key, definition.default]));
        state.settings = store;
        return { store };
    },
    Settings: { notifications: { useNative: "never" } },
    OptionType: {},
    Button: "button",
    React: { createElement: (...args) => args },
    createStore: () => null,
    get: async key => state.saved.get(key),
    set: async (key, value) => { state.saved.set(key, structuredClone(value)); },
    del: async key => { state.saved.delete(key); },
    keys: async () => [...state.saved.keys()],
    getMany: async keys => keys.map(key => state.saved.get(key)),
    addContextMenuPatch() {},
    removeContextMenuPatch() {},
    showNotification: notification => state.notifications.push(notification),
    openModal() {},
    HeaderBarButton: "button",
    ChannelStore: { getChannel: id => ({ id, name: `name-${id}`, guild_id: "guild" }) },
    GuildStore: { getGuild: () => ({ name: "Friends" }), getGuilds: () => ({ guild: {} }) },
    UserStore: { getUser: id => ({ id, username: state.names[id] ?? `user-${id}`, avatar: state.avatars[id], getAvatarURL: () => "" }) },
    UserProfileStore: { getUserProfile: id => state.profiles[id] },
    GuildMemberStore: { isMember: () => true, getNick: (_, id) => state.nicks[id] ?? null },
    MessageStore: { getMessage: (_, id) => state.messages[id] },
    fetchUserProfile: async () => ({}),
    ActivityDashboard: () => null,
    RadarIcon: () => null,
    PresenceStore: { getStatus: () => "online", getActivities: () => [] },
    FluxDispatcher: {
        subscribe(event, handler) { state.handlers[event] = handler; },
        unsubscribe() {}
    },
    VoiceStateStore: {
        getVoiceStateForUser: id => state.voice[id],
        getVoiceStatesForChannel: channelId => Object.fromEntries(Object.entries(state.voice).filter(([, voice]) => voice.channelId === channelId))
    }
};

globalThis.activityTrackerStubs = stubs;
globalThis.window = { addEventListener() {}, removeEventListener() {} };
globalThis.IS_DISCORD_DESKTOP = false;

const timers = [];
const realSetInterval = globalThis.setInterval;
globalThis.setInterval = (callback, ms) => {
    timers.push({ callback, ms });
    return realSetInterval(() => {}, 1 << 30);
};

const result = await build({
    entryPoints: [fileURLToPath(new URL("../src/userplugins/activityTracker/index.tsx", import.meta.url))],
    bundle: true, write: false, format: "cjs", platform: "node",
    plugins: [{
        name: "discord-test-stubs", setup(builder) {
            builder.onResolve({ filter: /^@(api|components|shared|utils|vencord|webpack)|^\.\/ui\// }, args => ({ path: args.path, namespace: "stub" }));
            builder.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ contents: "module.exports = globalThis.activityTrackerStubs;", loader: "js" }));
        }
    }]
});

const module = { exports: {} };
new Function("module", "exports", "require", result.outputFiles[0].text)(module, module.exports, () => ({}));
const plugin = module.exports.default;

const settle = async () => {
    for (let i = 0; i < 5; i++) await new Promise(resolve => setTimeout(resolve, 0));
};
const update = (userId, overrides) => {
    const voice = voiceState({ userId, guildId: "guild", ...overrides });
    if (voice.channelId) state.voice[userId] = voice;
    else delete state.voice[userId];
    plugin.handleVoiceStateUpdate({ voiceStates: [voice] });
};
const rows = () => plugin.getActivityLogs("target").map(log => log.voiceChannel?.action ?? log.voiceState?.change ?? (log.contact && `${log.contact.action}:${log.contact.userId}`));

plugin.start();
await settle();
plugin.trackUser("target");

state.voice.ana = voiceState({ channelId: "a" });
update("target", { channelId: "a" });
const [join] = plugin.getActivityLogs("target");
assert.equal(join.voiceChannel.action, "join");
assert.deepEqual(join.voiceChannel.present, [{ id: "ana", name: "user-ana" }], "A join must record who was there");
assert.equal(join.voiceChannel.channelName, "name-a");
assert.equal(join.voiceChannel.guildName, "Friends");

update("target", { channelId: "a", oldChannelId: "a", selfMute: true });
update("target", { channelId: "a", oldChannelId: "a", selfMute: true, selfStream: true });
update("target", { channelId: "a", oldChannelId: "a", selfMute: true, selfStream: true, selfVideo: true });
assert.deepEqual(rows(), ["join", "self_mute", "self_stream", "self_video"], "State changes must not look like moves");

update("bob", { channelId: "a" });
update("bob", { channelId: "a", oldChannelId: "a", selfMute: true });
update("bob", { channelId: "other", oldChannelId: "a" });
update("stranger", { channelId: "other", oldChannelId: "elsewhere" });
assert.deepEqual(rows().slice(4), ["joined:bob", "left:bob"], "Only arrivals and departures in that call are contacts");

update("target", { channelId: "b", oldChannelId: "a", selfMute: true, selfStream: true, selfVideo: true });
update("target", { channelId: null, oldChannelId: "b" });
assert.deepEqual(rows().slice(6), ["move", "leave"]);

assert.equal(state.notifications.length, 0, "notifyVoice is off by default");
state.settings.notifyVoice = true;
update("target", { channelId: "a" });
update("target", { channelId: "a", oldChannelId: "a", selfMute: true });
update("target", { channelId: "b", oldChannelId: "a", selfMute: true });
assert.equal(state.notifications.length, 1, "Only joins and leaves notify");
state.settings.notifyVoice = false;
update("target", { channelId: null, oldChannelId: "b" });

// The regular check, which catches what events miss.
const voiceCheck = timers.find(timer => timer.ms === 30_000).callback;
const before = rows().length;

state.voice.target = voiceState({ channelId: "c", selfVideo: true });
voiceCheck();
assert.deepEqual(rows().slice(before), ["join"], "A call already in progress must open a session");
assert.equal(plugin.getActivityLogs("target").at(-1).voiceChannel.detected, true);
assert.deepEqual(plugin.getActivityLogs("target").at(-1).voiceChannel.flags, ["camera on"]);

voiceCheck();
assert.equal(rows().length, before + 1, "No change must log nothing");

delete state.voice.target;
voiceCheck();
assert.equal(rows().length, before + 1, "A single empty check may be a reconnect");
state.voice.target = voiceState({ channelId: "c", selfVideo: true });
voiceCheck();
delete state.voice.target;
voiceCheck();
assert.equal(rows().length, before + 1, "The count of empty checks must reset");
voiceCheck();
assert.deepEqual(rows().slice(before), ["join", "leave"]);
assert.equal(plugin.getActivityLogs("target").at(-1).voiceChannel.detected, true);

plugin.handleMessageCreate({ message: { id: "1", channel_id: "a", author: { id: "target", username: "t" }, attachments: [{}, {}] } });
const message = plugin.getActivityLogs("target").at(-1).message;
assert.equal(message.content, "", "A message without text must not crash");
assert.equal(message.attachments, 2);

plugin.handleMessageCreate({
    message: {
        id: "2", channel_id: "a", content: "hi", author: { id: "target", username: "t" },
        mentions: [{ username: "ana" }], referenced_message: { author: { username: "bob" } }
    }
});
const reply = plugin.getActivityLogs("target").at(-1).message;
assert.equal(reply.replyTo, "bob");
assert.deepEqual(reply.mentions, ["ana"]);
assert.equal(reply.id, "2");

const lastLog = () => plugin.getActivityLogs("target").at(-1);
const count = () => plugin.getActivityLogs("target").length;

// Messages from people not being tracked.
const beforeOthers = count();
plugin.handleMessageCreate({ message: { id: "3", channel_id: "a", content: "x", author: { id: "other", username: "o" } } });
plugin.handleMessageUpdate({ message: { id: "3", channel_id: "a", content: "y", author: { id: "other" }, edited_timestamp: "t" } });
plugin.handleMessageDelete({ id: "3", channelId: "a" });
assert.equal(count(), beforeOthers, "Untracked people must not be recorded");

// Edits.
plugin.handleMessageUpdate({ message: { id: "2", channel_id: "a", content: "hi", author: { id: "target" } } });
assert.equal(count(), beforeOthers, "An embed loading doesn't change the text");
plugin.handleMessageUpdate({ message: { id: "2", channel_id: "a", embeds: [] } });
assert.equal(count(), beforeOthers, "An update without text is not an edit");

plugin.handleMessageUpdate({ message: { id: "2", channel_id: "a", content: "hello", author: { id: "target" }, edited_timestamp: "t" } });
assert.equal(lastLog().type, "messageEdit");
assert.equal(lastLog().messageEdit.before, "hi");
assert.equal(lastLog().messageEdit.after, "hello");

plugin.handleMessageUpdate({ message: { id: "2", channel_id: "a", content: "hello again", edited_timestamp: "t" } });
assert.equal(lastLog().messageEdit.before, "hello", "A second edit starts from the first, even without an author in the event");

plugin.handleMessageUpdate({ message: { id: "old", channel_id: "a", content: "sent earlier", author: { id: "target" }, edited_timestamp: "t" } });
assert.equal(lastLog().messageEdit.before, undefined, "An older message has an unknown original");

// Deletions, where Discord doesn't say who wrote the message.
plugin.handleMessageDelete({ id: "2", channelId: "a", guildId: "guild" });
assert.equal(lastLog().type, "messageDelete");
assert.equal(lastLog().messageDelete.content, "hello again", "The last text must survive deletion");

state.messages.stored = { author: { id: "target" }, content: "from discord" };
plugin.handleMessageDelete({ id: "stored", channelId: "a" });
assert.equal(lastLog().messageDelete.content, "from discord");

const beforeUnknown = count();
plugin.handleMessageDelete({ id: "never-seen", channelId: "a" });
assert.equal(count(), beforeUnknown, "A message we know nothing about can't be attributed");

plugin.handleMessageCreate({ message: { id: "b1", channel_id: "a", content: "one", author: { id: "target", username: "t" } } });
plugin.handleMessageCreate({ message: { id: "b2", channel_id: "a", content: "two", author: { id: "target", username: "t" } } });
plugin.handleMessageDeleteBulk({ ids: ["b1", "b2"], channelId: "a" });
assert.deepEqual(plugin.getActivityLogs("target").slice(-2).map(log => log.messageDelete.content), ["one", "two"]);

// Reactions.
state.messages.liked = { author: { username: "bob" }, content: "funny" };
plugin.handleReactionAdd({ userId: "target", channelId: "a", messageId: "liked", emoji: { name: "😂" } });
assert.equal(lastLog().reaction.emoji, "😂");
assert.equal(lastLog().reaction.targetAuthor, "bob");
plugin.handleReactionAdd({ userId: "target", channelId: "a", messageId: "liked", emoji: { id: "1", name: "wow" } });
assert.equal(lastLog().reaction.emoji, ":wow:");
const beforeReaction = count();
plugin.handleReactionAdd({ userId: "other", channelId: "a", messageId: "liked", emoji: { name: "x" } });
plugin.handleTyping({ userId: "other", channelId: "a" });
assert.equal(plugin.getActivityLogs("other").length, 0, "Nothing from untracked people may be stored");
state.settings.trackReactions = false;
plugin.handleReactionAdd({ userId: "target", channelId: "a", messageId: "liked", emoji: { name: "x" } });
assert.equal(count(), beforeReaction, "Reactions can be turned off");
state.settings.trackReactions = true;

// Typing, which Discord repeats every few seconds.
plugin.handleTyping({ userId: "target", channelId: "typing" });
assert.equal(lastLog().type, "typing");
const beforeTyping = count();
plugin.handleTyping({ userId: "target", channelId: "typing" });
assert.equal(count(), beforeTyping, "A burst of typing is one entry");
plugin.handleTyping({ userId: "target", channelId: "elsewhere" });
assert.equal(count(), beforeTyping + 1, "Another channel is a new entry");

// Conversations, from the plugin's own message events.
plugin.trackUser("talker");
const say = (userId, id) => plugin.handleMessageCreate({ message: { id, channel_id: "chat", content: "x", author: { id: userId, username: userId } } });
["talker", "friend", "talker", "friend"].forEach((userId, index) => say(userId, `c${index}`));
plugin.sweepChats(Infinity);
const chat = plugin.getActivityLogs("talker").find(log => log.type === "chat");
assert.equal(chat.chat.userId, "friend", "A back-and-forth must be recorded");
assert.equal(chat.chat.channelName, "name-chat");

// Profile versions.
plugin.trackUser("person");
state.names.person = "first";
state.avatars.person = "aaa";
state.profiles.person = { bio: "old bio" };
state.nicks.person = "nick1";
plugin.handleMessageCreate({ message: { id: "p1", channel_id: "a", content: "x", author: { id: "person", username: "first" } } });
await new Promise(resolve => setTimeout(resolve, 1700));
const versions = () => plugin.getActivityLogs("person").filter(log => log.type === "profile");
assert.equal(versions().length, 1);
assert.equal(versions()[0].profile.first, true);

state.names.person = "second";
state.avatars.person = "bbb";
state.profiles.person = { bio: "new bio" };
state.nicks.person = "nick2";
plugin.handlePresenceUpdates({ updates: [{ user: { id: "person" } }] });
await new Promise(resolve => setTimeout(resolve, 1700));
assert.equal(versions().length, 2);
assert.deepEqual(versions()[1].profile.changes.map(change => [change.field, change.before, change.after]), [
    ["username", "first", "second"], ["avatar", "aaa", "bbb"], ["bio", "old bio", "new bio"], ["nick", "nick1", "nick2"]
]);
assert.equal(versions()[1].profile.changes[3].guildName, "Friends");

plugin.stop();
await settle();

const saved = state.saved.get("ActivityTracker_data");
assert.deepEqual(saved.trackedUsers, ["target", "talker", "person"]);
assert.equal(saved.profiles.person.username, "second", "Profile versions must survive a restart");
assert.ok([...state.saved.keys()].some(key => key.startsWith("logs:")), "Logs must reach the day store");

console.log("ActivityTracker tests passed.");
process.exit(0);
