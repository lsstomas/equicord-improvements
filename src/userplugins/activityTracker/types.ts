/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { VoiceEvent } from "../../equicordplugins/voiceChannelLog/voiceEvents";
import { VoiceAction, VoicePeer } from "./voiceTracking";

export interface Activity {
    name: string;
    type: number;
    details?: string;
    state?: string;
    timestamps?: { start?: number; end?: number; };
}

/** Where something happened. Names are stored so logs stay readable after leaving a server. */
export interface Place {
    channelId: string;
    channelName: string;
    guildId?: string;
    guildName?: string;
}

export interface ProfileChange {
    field: "username" | "globalName" | "avatar" | "banner" | "bio" | "pronouns" | "avatarDecoration" | "nick";
    before?: string;
    after?: string;
    /** Server of a nickname change. */
    guildId?: string;
    guildName?: string;
}

export interface ActivityLog {
    userId: string;
    username: string;
    timestamp: number;
    type: "activity" | "voice" | "message" | "status" | "voiceState" | "contact" | "messageEdit" | "messageDelete" | "reaction" | "typing" | "profile" | "chat";
    activities?: Activity[];
    voiceChannel?: Place & {
        action: VoiceAction;
        /** Who was already in the channel. */
        present?: VoicePeer[];
        /** The user's state on arrival, such as "muted" or "camera on". */
        flags?: string[];
        /** Noticed by checking, not by an event, so the time is only the moment we noticed. */
        detected?: boolean;
    };
    voiceState?: Place & { change: VoiceEvent["type"]; enabled: boolean; };
    contact?: Place & { action: "joined" | "left"; userId: string; name: string; };
    message?: Place & {
        id?: string;
        content: string;
        attachments?: number;
        replyTo?: string;
        mentions?: string[];
    };
    messageEdit?: Place & { id: string; before?: string; after: string; };
    messageDelete?: Place & { id: string; content?: string; };
    reaction?: Place & { added: boolean; emoji: string; messageId: string; targetAuthor?: string; targetContent?: string; };
    typing?: Place;
    profile?: { first?: boolean; changes: ProfileChange[]; };
    chat?: Place & { userId: string; name: string; startedAt: number; endedAt: number; turns: number; };
    status?: { status: string; clientStatus?: Record<string, string>; };
}
