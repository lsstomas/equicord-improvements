/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Logger } from "@utils/Logger";
import { ChannelType } from "@vencord/discord-types/enums";
import { ChannelStore, GuildStore, IconUtils, moment, PermissionsBits, PermissionStore, PresenceStore, RelationshipStore, StreamerModeStore, UserStore, VoiceStateStore } from "@webpack/common";

import { showNotification } from "./components/Notifications";
import { navigateToChannel, settings } from "./index";

export interface VoiceUpdate {
    userId: string;
    channelId?: string | null;
    oldChannelId?: string | null;
}

const logger = new Logger("ToastNotifications");
const previousChannels = new Map<string, string | null>();
const voiceChannelTypes = new Set<number>([ChannelType.GUILD_VOICE, ChannelType.GUILD_STAGE_VOICE, ChannelType.DM, ChannelType.GROUP_DM]);
let ready = false;

export function parseTrackedVoiceUsers(value: string): string[] {
    return [...new Set(value.trim().split(/[\s,]+/).filter(id => /^\d{17,20}$/.test(id)))];
}

export function resetVoiceTracking() {
    previousChannels.clear();
    for (const id of parseTrackedVoiceUsers(settings.store.trackedVoiceUsers)) {
        previousChannels.set(id, VoiceStateStore.getVoiceStateForUser(id)?.channelId ?? null);
    }
    ready = true;
}

export function clearVoiceTracking() {
    previousChannels.clear();
    ready = false;
}

export function handleVoiceUpdates(states: VoiceUpdate[]) {
    if (!ready) return;
    const currentUser = UserStore.getCurrentUser();
    const tracked = new Set(parseTrackedVoiceUsers(settings.store.trackedVoiceUsers));

    for (const state of states) {
        if (!tracked.has(state.userId)) continue;
        const channelId = state.channelId ?? null;
        const previous = previousChannels.has(state.userId)
            ? previousChannels.get(state.userId)
            : state.oldChannelId ?? null;
        previousChannels.set(state.userId, channelId);
        if (!channelId || channelId === previous || state.oldChannelId === channelId) continue;
        const moved = !!previous || !!state.oldChannelId;
        if (!settings.store.voiceJoinNotifications || moved && !settings.store.voiceJoinIncludeMoves) continue;
        if (state.userId === currentUser.id || !RelationshipStore.isFriend(state.userId) || RelationshipStore.isBlocked(state.userId)) continue;
        if (settings.store.ignoreUsers.split(/[\s,]+/).includes(state.userId)) continue;
        if (settings.store.respectDoNotDisturb && PresenceStore.getStatus(currentUser.id) === "dnd") continue;
        if (settings.store.disableInStreamerMode && StreamerModeStore.enabled) continue;

        const channel = ChannelStore.getChannel(channelId);
        if (!channel || !voiceChannelTypes.has(channel.type)) continue;
        if (channel.guild_id && !PermissionStore.can(PermissionsBits.VIEW_CHANNEL, channel)) continue;
        const user = UserStore.getUser(state.userId);
        if (!user) continue;
        const guildName = channel.guild_id ? GuildStore.getGuild(channel.guild_id)?.name : undefined;
        const location = channel.guild_id
            ? `${guildName ?? "Server"} • ${channel.name}`
            : channel.name || "Private call";

        void showNotification({
            title: `${user.globalName ?? user.username} ${moved ? "moved voice channels" : "joined a voice channel"}`,
            body: `${location} • ${moment().format("LTS")}`,
            icon: IconUtils.getUserAvatarURL(user),
            onClick: () => navigateToChannel(channel)
        }).catch(error => logger.error("Could not display voice join notification", error));
    }
}
