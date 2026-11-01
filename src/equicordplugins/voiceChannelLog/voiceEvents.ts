/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { LogEventType, PreviousVoiceState, VoiceChannelLogEntry, VoiceState } from "./types";

export type VoiceEvent = Pick<VoiceChannelLogEntry, "type" | "channelId" | "enabled" | "oldChannelId" | "newChannelId" | "flags">;

type RawVoiceState = Pick<VoiceState, "mute" | "deaf" | "selfMute" | "selfDeaf" | "selfVideo" | "selfStream"> & { channelId?: string | null; };

export function toPreviousState(state: RawVoiceState): PreviousVoiceState {
    return {
        mute: !!state.mute,
        deaf: !!state.deaf,
        selfMute: !!state.selfMute,
        selfDeaf: !!state.selfDeaf,
        selfVideo: !!state.selfVideo,
        selfStream: !!state.selfStream,
        channelId: state.channelId ?? undefined
    };
}

export function getVoiceFlags(state: PreviousVoiceState): string[] | undefined {
    const flags = [
        (state.selfDeaf || state.deaf) && "deafened",
        (state.selfMute || state.mute) && !state.selfDeaf && !state.deaf && "muted",
        state.selfVideo && "camera on",
        state.selfStream && "screensharing"
    ].filter(flag => typeof flag === "string");

    return flags.length ? flags : undefined;
}

export function diffState(previous: PreviousVoiceState, next: PreviousVoiceState, channelId: string): VoiceEvent[] {
    const events: VoiceEvent[] = [];
    const push = (type: LogEventType, enabled: boolean) => events.push({ type, channelId, enabled });

    const deafenChanged = previous.selfDeaf !== next.selfDeaf;

    // Discord flips the mic together with deafen; that is one action, not two.
    if (next.selfMute !== previous.selfMute && !(deafenChanged && next.selfMute === next.selfDeaf)) {
        push("self_mute", next.selfMute);
    }
    if (deafenChanged) push("self_deafen", next.selfDeaf);
    if (next.mute !== previous.mute) push("server_mute", next.mute);
    if (next.deaf !== previous.deaf) push("server_deafen", next.deaf);
    if (next.selfVideo !== previous.selfVideo) push("self_video", next.selfVideo);
    if (next.selfStream !== previous.selfStream) push("self_stream", next.selfStream);

    return events;
}

export interface VoiceUpdate {
    /** The call this client is connected to. Nothing else is recorded. */
    myChannelId: string | null;
    previous: PreviousVoiceState | undefined;
    next: PreviousVoiceState;
    oldChannelId: string | null | undefined;
    isMe: boolean;
    /** The client just connected, so a user it doesn't know may simply be arriving in its state. */
    joinedRecently: boolean;
}

/** Works out what one voice state update means for the call this client is in. */
export function getVoiceEvents({ myChannelId, previous, next, oldChannelId, isMe, joinedRecently }: VoiceUpdate): VoiceEvent[] {
    if (!myChannelId) return [];

    const from = previous?.channelId ?? oldChannelId ?? null;
    const to = next.channelId ?? null;
    const wasHere = from === myChannelId;
    const isHere = to === myChannelId;

    if (!wasHere && !isHere) return [];

    const flags = getVoiceFlags(next);

    if (wasHere && isHere) {
        if (previous) return diffState(previous, next, myChannelId);
        return isMe ? [] : [{ type: "present", channelId: myChannelId, flags }];
    }

    // Our own joins, leaves and moves are recorded when the selected channel changes.
    if (isMe) return [];

    if (isHere) {
        if (from) return [{ type: "move", channelId: myChannelId, oldChannelId: from, newChannelId: to, flags }];
        return [{ type: joinedRecently ? "present" : "join", channelId: myChannelId, flags }];
    }

    return to
        ? [{ type: "move", channelId: myChannelId, oldChannelId: from, newChannelId: to }]
        : [{ type: "leave", channelId: myChannelId }];
}
