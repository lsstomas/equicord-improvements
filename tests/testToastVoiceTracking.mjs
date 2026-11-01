/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

import { build } from "esbuild";

const friend = "111111111111111111";
const other = "222222222222222222";
const me = "333333333333333333";
const state = { notifications: [], channels: new Map(), voice: new Map(), blocked: new Set(), friends: new Set([friend, other]), navigated: [], status: "online", permission: true };
const React = { createElement: (type, props, ...children) => ({ type, props: { ...props, children } }) };
const stubs = {
    __esModule: true,
    default: plugin => plugin,
    Button: "button",
    React,
    Menu: { MenuSeparator: "separator", MenuCheckboxItem: "checkbox" },
    Logger: class { error() {} },
    OptionType: {},
    ChannelType: { GUILD_VOICE: 2, GUILD_STAGE_VOICE: 13, DM: 1, GROUP_DM: 3 },
    UserNotificationSetting: { NO_MESSAGES: 2, ALL_MESSAGES: 0 },
    EquicordDevs: {},
    makeRange: () => [],
    definePluginSettings(definitions) {
        state.definitions = definitions;
        const values = Object.fromEntries(Object.entries(definitions).map(([key, def]) => [key, def.default ?? def.options?.find(option => option.default)?.value]));
        state.settings = new Proxy(values, {
            set(target, key, value) {
                target[key] = value;
                definitions[key]?.onChange?.(value);
                return true;
            }
        });
        return { store: state.settings };
    },
    findByPropsLazy: () => ({ selectPrivateChannel: id => state.navigated.push(id), updateChatOpen() {} }),
    ChannelStore: { getChannel: id => state.channels.get(id), hasChannel: id => state.channels.has(id) },
    GuildStore: { getGuild: () => ({ name: "Test server" }) },
    VoiceStateStore: { getVoiceStateForUser: id => state.voice.has(id) ? { channelId: state.voice.get(id) } : undefined },
    UserStore: { getCurrentUser: () => ({ id: me }), getUser: id => ({ id, username: "Friend" }) },
    RelationshipStore: { isFriend: id => state.friends.has(id), isBlocked: id => state.blocked.has(id) },
    PermissionsBits: { VIEW_CHANNEL: 1024n },
    PermissionStore: { can: () => state.permission },
    PresenceStore: { getStatus: () => state.status },
    StreamerModeStore: { enabled: false },
    SelectedChannelStore: { getChannelId: () => state.selectedChannelId ?? "viewing-another-channel", getVoiceChannelId: () => state.selectedVoiceChannelId },
    IconUtils: { getUserAvatarURL: () => "avatar" },
    moment: () => ({ format: () => "12:34:56" }),
    NavigationRouter: { transitionTo: route => state.navigated.push(route) },
    UserGuildSettingsStore: { isChannelMuted: () => false },
    MessageStore: { getMessages: () => ({ receiveMessage: message => ({ get: () => message }) }) },
    async showNotification(notification) { state.notifications.push(notification); },
    setContainerPosition() {},
    teardownNotifications() {}
};

const result = await build({
    entryPoints: [fileURLToPath(new URL("../src/equicordplugins/toastNotifications/index.tsx", import.meta.url))],
    bundle: true, write: false, format: "cjs", platform: "node",
    plugins: [{ name: "discord-test-stubs", setup(builder) {
        builder.onResolve({ filter: /^@|^\.\/components\/Notifications$/ }, args => ({ path: args.path, namespace: "stub" }));
        builder.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ contents: "module.exports = globalThis.stubs;", loader: "js" }));
    } }]
});
const box = { module: { exports: {} }, stubs, React, console };
box.exports = box.module.exports;
vm.runInNewContext(result.outputFiles[0].text, box);
const plugin = box.module.exports.default;
const settings = state.settings;
const emit = (userId, channelId, oldChannelId) => plugin.flux.VOICE_STATE_UPDATES({ voiceStates: [{ userId, channelId, oldChannelId }] });
const count = () => state.notifications.length;
const channel = id => ({ id, guild_id: "guild", name: id, type: 2 });
state.channels.set("call-a", channel("call-a"));
state.channels.set("call-b", channel("call-b"));
plugin.start();
emit(friend, "call-a");
assert.equal(count(), 0, "Empty tracking list must not notify");
assert.equal(state.definitions.trackedVoiceUsers.isValid("not-an-id"), "Enter user IDs separated by commas or spaces.");
settings.trackedVoiceUsers = friend;
emit(other, "call-a");
assert.equal(count(), 0, "Untracked friends must not notify");
emit(friend, "call-a");
assert.equal(count(), 1);
assert.match(state.notifications[0].title, /joined a voice channel/);
assert.match(state.notifications[0].body, /Test server.*call-a.*12:34:56/);
state.notifications[0].onClick();
assert.deepEqual(state.navigated, ["/channels/guild/call-a/"]);
emit(friend, "call-a");
emit(friend, "call-a", "call-a");
assert.equal(count(), 1, "Duplicate and same-channel updates must not notify");
emit(friend, "call-b", "call-a");
assert.equal(count(), 1, "Moves are disabled by default");
settings.voiceJoinIncludeMoves = true;
emit(friend, "call-a", "call-b");
assert.equal(count(), 2);
assert.match(state.notifications.at(-1).title, /moved voice channels/);
emit(friend, null, "call-a");
emit(friend, "call-a");
assert.equal(count(), 3, "Leaving and rejoining must notify again");

for (const [label, block, unblock] of [
    ["blocked", () => state.blocked.add(friend), () => state.blocked.clear()],
    ["not friends", () => state.friends.delete(friend), () => state.friends.add(friend)],
    ["ignored", () => { settings.ignoreUsers = friend; }, () => { settings.ignoreUsers = ""; }],
    ["DND", () => { settings.respectDoNotDisturb = true; state.status = "dnd"; }, () => { state.status = "online"; }],
    ["streamer mode", () => { stubs.StreamerModeStore.enabled = true; }, () => { stubs.StreamerModeStore.enabled = false; }],
    ["hidden channel", () => { state.permission = false; }, () => { state.permission = true; }],
    ["disabled", () => { settings.voiceJoinNotifications = false; }, () => { settings.voiceJoinNotifications = true; }]
]) {
    emit(friend, null, "call-a");
    const before = count();
    block();
    emit(friend, "call-a");
    assert.equal(count(), before, `${label} must suppress notifications`);
    unblock();
}

state.voice.set(friend, "call-a");
plugin.flux.CONNECTION_CLOSED();
const beforeReconnect = count();
emit(friend, "call-a");
plugin.flux.CONNECTION_OPEN();
emit(friend, "call-a");
assert.equal(count(), beforeReconnect, "Reconnect must not replay a cached call");
state.voice.delete(friend);
settings.trackedVoiceUsers = "";
const menu = [];
plugin.contextMenus["user-context"](menu, { user: { id: friend } });
assert.equal(menu.at(-1).props.label, "Track Voice Joins");
menu.at(-1).props.action();
assert.equal(settings.trackedVoiceUsers, friend);
emit(friend, null);
emit(friend, "call-a");
assert.equal(count(), beforeReconnect + 1, "Tracking through user menu must work");
const removeMenu = [];
plugin.contextMenus["user-context"](removeMenu, { user: { id: friend } });
removeMenu.at(-1).props.action();
assert.equal(settings.trackedVoiceUsers, "");
emit(friend, null);
emit(friend, "call-a");
assert.equal(count(), beforeReconnect + 1, "Removing tracking must stop notifications");

settings.trackedVoiceUsers = friend;
emit(friend, null);
state.selectedChannelId = "call-a";
state.selectedVoiceChannelId = "call-a";
const beforeSameCall = count();
emit(friend, "call-a");
assert.equal(count(), beforeSameCall + 1, "A friend joining the same call and open channel must still notify");
settings.trackedVoiceUsers = "";
state.selectedChannelId = undefined;
state.selectedVoiceChannelId = undefined;

state.channels.set("dm", { id: "dm", type: 1, isDM: () => true, isGroupDM: () => false });
const message = { id: "message", channel_id: "dm", author: { id: other }, content: "Existing DM notification" };
plugin.flux.MESSAGE_CREATE({ message });
assert.equal(state.notifications.at(-1).message, message, "Existing DM notifications must keep working");
plugin.stop();
console.log("Toast voice tracking passed: opt-in list, menu add/remove, joins, moves, deduplication, permission/privacy filters, reconnect and existing DM notifications.");
