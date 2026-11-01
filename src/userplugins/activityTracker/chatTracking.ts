/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export interface ChatSession {
    trackedId: string;
    otherId: string;
    otherName: string;
    trackedName: string;
    channelId: string;
    startedAt: number;
    endedAt: number;
    /** How many times the conversation changed hands. */
    turns: number;
}

interface OpenSession {
    channelId: string;
    a: { id: string; name: string; };
    b: { id: string; name: string; };
    startedAt: number;
    lastAt: number;
    lastSpeaker: string;
    turns: number;
}

interface ChatOptions {
    /** Silence that ends a conversation. */
    gapMs: number;
    /** Turns needed to count as a conversation and not two people talking in the same room. */
    minTurns: number;
    isTracked(userId: string): boolean;
    onSession(session: ChatSession): void;
}

/** Spots two people going back and forth in a channel, from the order of their messages. */
export function createChatTracker({ gapMs, minTurns, isTracked, onSession }: ChatOptions) {
    const speakers = new Map<string, Map<string, { name: string; at: number; }>>();
    const sessions = new Map<string, OpenSession>();

    const sessionKey = (channelId: string, first: string, second: string) => `${channelId}:${[first, second].sort().join(":")}`;

    function finish(key: string, session: OpenSession) {
        sessions.delete(key);
        if (session.turns < minTurns) return;

        for (const [tracked, other] of [[session.a, session.b], [session.b, session.a]]) {
            if (!isTracked(tracked.id)) continue;

            onSession({
                trackedId: tracked.id,
                trackedName: tracked.name,
                otherId: other.id,
                otherName: other.name,
                channelId: session.channelId,
                startedAt: session.startedAt,
                endedAt: session.lastAt,
                turns: session.turns
            });
        }
    }

    function touch(channelId: string, author: { id: string; name: string; }, other: { id: string; name: string; since: number; }, at: number, weight: number) {
        const key = sessionKey(channelId, author.id, other.id);
        const session = sessions.get(key);

        if (!session) {
            sessions.set(key, {
                channelId, a: author, b: other, startedAt: other.since, lastAt: at, lastSpeaker: author.id, turns: 1 + weight
            });
            return;
        }

        if (session.lastSpeaker !== author.id) session.turns += weight;
        session.lastSpeaker = author.id;
        session.lastAt = at;
    }

    return {
        /** directIds are people this message replied to or mentioned, which is a stronger link. */
        observe(channelId: string, author: { id: string; name: string; }, at: number, directIds: string[] = []) {
            const channel = speakers.get(channelId) ?? new Map<string, { name: string; at: number; }>();
            speakers.set(channelId, channel);

            for (const [id, speaker] of channel) {
                if (id === author.id || at - speaker.at > gapMs) continue;
                if (!isTracked(id) && !isTracked(author.id)) continue;

                touch(channelId, author, { id, name: speaker.name, since: speaker.at }, at, directIds.includes(id) ? 2 : 1);
            }

            channel.set(author.id, { name: author.name, at });
        },

        /** Closes conversations that went quiet. Pass Infinity to close all of them. */
        sweep(now: number) {
            for (const [key, session] of sessions) {
                if (now - session.lastAt > gapMs) finish(key, session);
            }

            for (const [channelId, channel] of speakers) {
                for (const [id, speaker] of channel) {
                    if (now - speaker.at > gapMs) channel.delete(id);
                }
                if (!channel.size) speakers.delete(channelId);
            }
        }
    };
}
