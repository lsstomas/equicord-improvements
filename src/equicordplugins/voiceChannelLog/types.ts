/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { User } from "@vencord/discord-types";

export type LogEventType =
    | "join"
    | "leave"
    | "move"
    | "present"
    | "soundboard"
    | "self_mute"
    | "self_deafen"
    | "server_mute"
    | "server_deafen"
    | "self_video"
    | "self_stream"
    | "activity"
    | "activity_stop";

export interface Emoji {
    name: string;
    id?: string;
    animated: boolean;
}

export interface VoiceChannelLogEntry {
    id: string;
    type: LogEventType;
    userId: string;
    channelId: string;
    timestamp: Date;
    /** When we connected to this channel, for "into the call" labels on old logs. */
    callStartedAt?: number;
    /** Names are stored with the log so it stays readable after a server or user is gone. */
    guildId?: string;
    guildName?: string;
    channelName?: string;
    username?: string;
    displayName?: string;
    avatar?: string;
    oldChannelId?: string | null;
    oldChannelName?: string;
    newChannelId?: string | null;
    newChannelName?: string;
    /** The user's state on arrival, such as "muted" or "camera on". */
    flags?: string[];
    soundId?: string;
    emoji?: Emoji;
    enabled?: boolean;
    activityName?: string;
    applicationId?: string;
}

export interface VoiceState {
    guildId?: string;
    channelId?: string;
    oldChannelId?: string;
    user: User;
    userId: string;
    mute: boolean;
    deaf: boolean;
    selfMute: boolean;
    selfDeaf: boolean;
    selfVideo: boolean;
    selfStream?: boolean;
}

export interface SoundEvent {
    type: "VOICE_CHANNEL_EFFECT_SEND";
    emoji?: Emoji;
    channelId: string;
    userId: string;
    soundId?: string;
}

export interface EmbeddedActivityEvent {
    applicationId: string;
    location?: {
        channel_id?: string;
        guild_id?: string;
    };
    participants?: Array<{
        user_id: string;
        session_id: string;
    }>;
}

export interface PreviousVoiceState {
    mute: boolean;
    deaf: boolean;
    selfMute: boolean;
    selfDeaf: boolean;
    selfVideo: boolean;
    selfStream: boolean;
    channelId?: string;
}
