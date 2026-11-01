/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { Button } from "@components/Button";
import { EquicordDevs } from "@utils/constants";
import definePlugin, { makeRange, OptionType } from "@utils/types";
import { Channel, Message, User } from "@vencord/discord-types";
import { UserNotificationSetting } from "@vencord/discord-types/enums";
import { findByPropsLazy } from "@webpack";
import { ChannelStore, IconUtils, Menu, MessageStore, NavigationRouter, PresenceStore, RelationshipStore, SelectedChannelStore, StreamerModeStore, UserGuildSettingsStore, UserStore } from "@webpack/common";

import { setContainerPosition, showNotification, teardownNotifications } from "./components/Notifications";
import { clearVoiceTracking, handleVoiceUpdates, parseTrackedVoiceUsers, resetVoiceTracking, VoiceUpdate } from "./voiceTracking";

const SelectedChannelActionCreators = findByPropsLazy("selectPrivateChannel");
const ChannelRTCActions = findByPropsLazy("updateChatOpen", "toggleParticipants");

const ID_REGEX = /^\d{17,20}$/;

let ignoredUsers: string[] = [];
let notifyFor: string[] = [];

export const settings = definePluginSettings({
    position: {
        type: OptionType.SELECT,
        description: "The position of the toast notification.",
        options: [
            {
                label: "Bottom Left",
                value: "bottom-left",
                default: true
            },
            {
                label: "Top Left",
                value: "top-left"
            },
            {
                label: "Top Right",
                value: "top-right"
            },
            {
                label: "Bottom Right",
                value: "bottom-right"
            },
        ],
        onChange: value => setContainerPosition(value),
    },
    timeout: {
        type: OptionType.SLIDER,
        description: "Time in seconds notifications will be shown for.",
        default: 5,
        markers: makeRange(1, 15, 1)
    },
    opacity: {
        type: OptionType.SLIDER,
        description: "The visible opacity of the notification.",
        default: 100,
        markers: makeRange(10, 100, 10)
    },
    maxNotifications: {
        type: OptionType.SLIDER,
        description: "Maximum number of notifications displayed at once.",
        default: 3,
        markers: makeRange(1, 5, 1)
    },
    disableInStreamerMode: {
        type: OptionType.BOOLEAN,
        description: "Do not show notifications when streamer mode is enabled.",
        default: true
    },
    respectDoNotDisturb: {
        type: OptionType.BOOLEAN,
        description: "Do not show notifications when your status is Do Not Disturb.",
        default: false
    },
    directMessages: {
        type: OptionType.BOOLEAN,
        description: "Show notifications for direct messages.",
        default: true
    },
    groupMessages: {
        type: OptionType.BOOLEAN,
        description: "Show notifications for group messages.",
        default: true
    },
    friendServerNotifications: {
        type: OptionType.BOOLEAN,
        description: "Show notifications when friends send messages in servers they share with you.",
        default: true
    },
    voiceJoinNotifications: {
        type: OptionType.BOOLEAN,
        description: "Show toasts when tracked friends join voice channels. An empty tracking list does not notify for anyone.",
        default: true,
        onChange: resetVoiceTracking
    },
    trackedVoiceUsers: {
        type: OptionType.STRING,
        description: "User IDs of friends to track, separated by commas or spaces. You can also right-click a friend and select Track Voice Joins.",
        default: "",
        placeholder: "000000000000000000, 111111111111111111",
        isValid: value => typeof value === "string" && (!value.trim() || value.trim().split(/[\s,]+/).every(id => ID_REGEX.test(id)) || "Enter user IDs separated by commas or spaces."),
        onChange: resetVoiceTracking
    },
    voiceJoinIncludeMoves: {
        type: OptionType.BOOLEAN,
        description: "Also notify when a tracked friend moves directly between voice channels.",
        default: false
    },
    ignoreUsers: {
        type: OptionType.STRING,
        description: "A list of user IDs (separate by commas) to ignore displaying notifications for.",
        onChange: () => { ignoredUsers = parseIdList(settings.store.ignoreUsers); },
        default: "",
        placeholder: "000000000000000000,111111111111111111,222222222222222222"
    },
    notifyFor: {
        type: OptionType.STRING,
        description: "A list of channel IDs (separate by commas) to always receive notifications from.",
        onChange: () => { notifyFor = parseIdList(settings.store.notifyFor); },
        default: "",
        placeholder: "000000000000000000,111111111111111111,222222222222222222"
    },
    exampleButton: {
        type: OptionType.COMPONENT,
        description: "Show an example toast notification.",
        component: () => <Button onClick={showExampleNotification}>Show Example Notification</Button>
    }
});

export default definePlugin({
    name: "ToastNotifications",
    description: "Show a pop-up toast notification, configurable for DMs, group, friends, or guild channels.",
    tags: ["Appearance", "Customisation", "Notifications"],
    authors: [EquicordDevs.Skully, EquicordDevs.Ethan, EquicordDevs.Buzzy],
    settings,
    contextMenus: {
        "user-context"(children, { user }: { user: User; }) {
            if (!user || user.id === UserStore.getCurrentUser().id || !RelationshipStore.isFriend(user.id)) return;
            const tracked = parseTrackedVoiceUsers(settings.store.trackedVoiceUsers);
            children.push(
                <Menu.MenuSeparator />,
                <Menu.MenuCheckboxItem
                    id="toast-track-voice-joins"
                    label="Track Voice Joins"
                    checked={tracked.includes(user.id)}
                    action={() => {
                        settings.store.trackedVoiceUsers = tracked.includes(user.id)
                            ? tracked.filter(id => id !== user.id).join(", ")
                            : [...tracked, user.id].join(", ");
                    }}
                />
            );
        }
    },
    flux: {
        VOICE_STATE_UPDATES({ voiceStates }: { voiceStates: VoiceUpdate[]; }) {
            handleVoiceUpdates(voiceStates);
        },
        CONNECTION_OPEN: resetVoiceTracking,
        CONNECTION_CLOSED: clearVoiceTracking,
        MESSAGE_CREATE({ message }: { message: Message; }) {
            const channel: Channel = ChannelStore.getChannel(message.channel_id);
            if (!channel) return;

            const currentUser = UserStore.getCurrentUser();

            // Check global conditions for all message types.
            if (
                (message.author.id === currentUser.id) // If message is from the user.
                || (channel.id === SelectedChannelStore.getChannelId()) // If the user is currently in the channel.
                || (ignoredUsers.includes(message.author.id)) // If the user is ignored.
                || (settings.store.respectDoNotDisturb && PresenceStore.getStatus(currentUser.id) === "dnd") // If notifications are disabled while in DND.
                || (settings.store.disableInStreamerMode && StreamerModeStore.enabled) // If notifications are disabled in streamer mode.
            ) return;

            // Channel type checks.
            if (channel.guild_id) {
                if (!shouldNotifyForGuildMessage(message, channel)) return;
            } else {
                if (
                    (!settings.store.directMessages && channel.isDM()) // If DM notifications are disabled.
                    || (!settings.store.groupMessages && channel.isGroupDM()) // If group DM notifications are disabled.
                    || UserGuildSettingsStore.isChannelMuted(null, channel.id) // If the user has muted the DM/group channel.
                ) return;
            }

            // Retrieve the message component for the message.
            const mockedMessage: Message | undefined = MessageStore.getMessages(message.channel_id)?.receiveMessage(message)?.get(message.id);
            if (!mockedMessage) return console.error(`[ToastNotifications] Failed to retrieve mocked message from MessageStore for message ID ${message.id}!`);

            showNotification({
                message,
                mockedMessage,
                channel,
                onClick: () => channel.guild_id
                    ? navigateToChannel(channel)
                    : SelectedChannelActionCreators.selectPrivateChannel(channel.id)
            });
        }
    },

    start() {
        ignoredUsers = parseIdList(settings.store.ignoreUsers);
        notifyFor = parseIdList(settings.store.notifyFor);
        resetVoiceTracking();
    },

    stop() {
        clearVoiceTracking();
        teardownNotifications();
        ignoredUsers = [];
        notifyFor = [];
    }
});

/**
 * Splits a comma-separated string into a list of valid Discord snowflake IDs.
 */
function parseIdList(str: string): string[] {
    if (!str) return [];
    return str.replace(/\s/g, "").split(",").filter(id => ID_REGEX.test(id));
}

/**
 * Navigates the client to the given channel, opening the chat panel for voice channels.
 */
export function navigateToChannel(channel: Channel) {
    if (!ChannelStore.hasChannel(channel.id)) return;
    NavigationRouter.transitionTo(`/channels/${channel.guild_id ?? "@me"}/${channel.id}/`);
    if (channel.isGuildVocal?.()) ChannelRTCActions.updateChatOpen(channel.id, true);
}

/**
 * Decides whether a guild message should trigger a notification based on the
 * channel allowlist, friend-server-notifications setting, channel/guild mutes,
 * and the user's configured notification level for the channel/guild.
 */
function shouldNotifyForGuildMessage(message: Message, channel: Channel): boolean {
    // Allowlist always wins.
    if (notifyFor.includes(channel.id)) return true;

    // Friend-in-server toggle.
    if (settings.store.friendServerNotifications && RelationshipStore.isFriend(message.author.id)) return true;

    // Respect the user's mute state for the guild/category/channel.
    if (UserGuildSettingsStore.isGuildOrCategoryOrChannelMuted(channel.guild_id, channel.id)) return false;

    // Resolve the user's configured notification level for the channel/guild.
    const userGuildSettings = UserGuildSettingsStore.getAllSettings().userGuildSettings[channel.guild_id];
    if (!userGuildSettings) return false;

    const channelOverride = userGuildSettings.channel_overrides?.[channel.id];
    const level: UserNotificationSetting = (channelOverride && typeof channelOverride === "object" && "message_notifications" in channelOverride)
        ? channelOverride.message_notifications
        : (typeof userGuildSettings.message_notifications === "number" ? userGuildSettings.message_notifications : UserNotificationSetting.NO_MESSAGES);

    if (level === UserNotificationSetting.NO_MESSAGES) return false;
    if (level === UserNotificationSetting.ALL_MESSAGES) return true;

    // Otherwise we only notify if the user was mentioned.
    return message.content.includes(`<@${UserStore.getCurrentUser().id}>`);
}

function showExampleNotification(): Promise<void> {
    return showNotification({
        title: "Example Notification",
        body: "This is an example toast notification!",
        icon: IconUtils.getUserAvatarURL(UserStore.getCurrentUser()),
        permanent: false
    });
}
