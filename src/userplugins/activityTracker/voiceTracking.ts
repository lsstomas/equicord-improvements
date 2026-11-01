/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { PreviousVoiceState } from "../../equicordplugins/voiceChannelLog/types";
import { diffState, VoiceEvent } from "../../equicordplugins/voiceChannelLog/voiceEvents";

export type VoiceAction = "join" | "leave" | "move";

export interface VoicePeer {
    id: string;
    name: string;
}

export interface TrackedVoiceUpdate {
    action: VoiceAction | null;
    /** Mute, deafen, camera and screenshare changes in the same channel. */
    changes: VoiceEvent[];
}

/** Only a different channel is a join, leave or move. Everything else is a state change. */
export function getTrackedVoiceUpdate(previous: PreviousVoiceState | undefined, next: PreviousVoiceState, oldChannelId?: string | null): TrackedVoiceUpdate {
    const from = previous?.channelId ?? oldChannelId ?? null;
    const to = next.channelId ?? null;

    if (from === to) {
        return { action: null, changes: previous && to ? diffState(previous, next, to) : [] };
    }

    if (!from) return { action: "join", changes: [] };
    return { action: to ? "move" : "leave", changes: [] };
}

/** Tracked users sharing a channel with someone who just arrived or left, and which it was. */
export function getContactChanges(trackedChannels: Iterable<[string, string | undefined]>, userId: string, from: string | null, to: string | null) {
    const changes: { trackedId: string; action: "joined" | "left"; channelId: string; }[] = [];
    if (from === to) return changes;

    for (const [trackedId, channelId] of trackedChannels) {
        if (trackedId === userId || !channelId) continue;
        if (channelId === to) changes.push({ trackedId, action: "joined", channelId });
        else if (channelId === from) changes.push({ trackedId, action: "left", channelId });
    }

    return changes;
}
