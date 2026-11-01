/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ActivityLog, Place, ProfileChange } from "./types";

const VOICE_CHANGES: Record<string, [string, string]> = {
    self_mute: ["Muted", "Unmuted"],
    self_deafen: ["Deafened", "Undeafened"],
    server_mute: ["Server muted", "Server unmuted"],
    server_deafen: ["Server deafened", "Server undeafened"],
    self_video: ["Turned on camera", "Turned off camera"],
    self_stream: ["Started screensharing", "Stopped screensharing"]
};

const PROFILE_FIELDS: Record<ProfileChange["field"], string> = {
    username: "Username",
    globalName: "Display name",
    avatar: "Avatar",
    banner: "Banner",
    bio: "Bio",
    pronouns: "Pronouns",
    avatarDecoration: "Avatar decoration",
    nick: "Server nickname"
};

export const describeField = (change: ProfileChange) => change.guildName ? `${PROFILE_FIELDS[change.field]} in ${change.guildName}` : PROFILE_FIELDS[change.field];

// Older logs stored these placeholders when Discord hadn't loaded the channel.
const isUnknownChannel = (name: string) => name.startsWith("Channel ID:") || name.startsWith("Unknown channel");

export function describePlace({ channelName, guildName }: Place): string {
    if (guildName === "DM" || !guildName) return isUnknownChannel(channelName) || guildName === "DM" ? "Direct message" : channelName;
    return isUnknownChannel(channelName) ? `Unknown channel in ${guildName}` : `#${channelName} in ${guildName}`;
}

/** One line in plain words, used by the timeline, search and exports. */
export function describeLog(log: ActivityLog): string {
    const { voiceChannel: voice, voiceState, contact, message, messageEdit, messageDelete, reaction, typing, profile, chat, status, activities } = log;

    if (message) return message.content || `Sent ${message.attachments ?? "an"} attachment${(message.attachments ?? 1) > 1 ? "s" : ""}`;
    if (messageEdit) return `Edited a message: ${messageEdit.after}`;
    if (messageDelete) return messageDelete.content ? `Deleted a message: ${messageDelete.content}` : "Deleted a message";
    if (reaction) return `${reaction.added ? "Reacted" : "Removed reaction"} ${reaction.emoji}${reaction.targetAuthor ? ` on ${reaction.targetAuthor}'s message` : ""}`;
    if (typing) return "Started typing";
    if (voiceState) return VOICE_CHANGES[voiceState.change]?.[voiceState.enabled ? 0 : 1] ?? voiceState.change;
    if (contact) return `${contact.name} ${contact.action} the call`;
    if (chat) return `Talked with ${chat.name} (${chat.turns} replies)`;
    if (status) return `Went ${status.status === "dnd" ? "do not disturb" : status.status}`;
    if (voice) return { join: "Joined a call", leave: "Left a call", move: "Moved to another call" }[voice.action];
    if (activities) return activities.map(activity => activity.details ? `${activity.name}: ${activity.details}` : activity.name).join(", ") || "Stopped an activity";

    if (profile) {
        return profile.first
            ? "First profile snapshot"
            : `Changed ${profile.changes.map(change => describeField(change).toLowerCase()).join(", ")}`;
    }

    return log.type;
}

export function getLogPlace(log: ActivityLog): Place | undefined {
    return log.message ?? log.messageEdit ?? log.messageDelete ?? log.reaction ?? log.typing ?? log.voiceState ?? log.contact ?? log.chat ?? log.voiceChannel;
}

export function getMessageLink(log: ActivityLog): string | undefined {
    const place = log.message ?? log.messageEdit ?? log.reaction;
    const id = log.message?.id ?? log.messageEdit?.id ?? log.reaction?.messageId;

    return place && id ? `/channels/${place.guildId ?? "@me"}/${place.channelId}/${id}` : undefined;
}
