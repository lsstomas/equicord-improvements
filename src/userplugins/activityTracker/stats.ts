/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ActivityLog, Place } from "./types";
import { VoicePeer } from "./voiceTracking";

const DAY_MS = 86_400_000;

export interface VoiceSession {
    userId: string;
    username: string;
    startedAt: number;
    endedAt: number | null;
    durationMs: number;
    place: Place;
    /** The end was only noticed later, for example after Discord was closed. */
    approximate?: boolean;
    present?: VoicePeer[];
    flags?: string[];
}

export type TimelineEntry =
    | { kind: "log"; log: ActivityLog; at: number; }
    | { kind: "session"; session: VoiceSession; at: number; };

/** Joins and leaves become one entry each session, oldest first. */
export function pairVoiceSessions(logs: ActivityLog[], now = Date.now()): TimelineEntry[] {
    const open = new Map<string, VoiceSession>();
    const entries: TimelineEntry[] = [];

    const close = (userId: string, endedAt: number | null, approximate?: boolean) => {
        const session = open.get(userId);
        if (!session) return;

        open.delete(userId);
        entries.push({
            kind: "session",
            at: session.startedAt,
            session: { ...session, endedAt, approximate, durationMs: (endedAt ?? now) - session.startedAt }
        });
    };

    for (const log of logs) {
        const voice = log.voiceChannel;

        if (log.type !== "voice" || !voice) {
            entries.push({ kind: "log", log, at: log.timestamp });
            continue;
        }

        if (voice.action === "leave") {
            close(log.userId, log.timestamp, voice.detected);
            continue;
        }

        // Older logs recorded every mute or camera change as a move within the same channel.
        if (voice.action === "move" && open.get(log.userId)?.place.channelId === voice.channelId) continue;

        close(log.userId, log.timestamp);
        open.set(log.userId, {
            userId: log.userId,
            username: log.username,
            startedAt: log.timestamp,
            endedAt: null,
            durationMs: 0,
            place: voice,
            present: voice.present,
            flags: voice.flags
        });
    }

    [...open.keys()].forEach(userId => close(userId, null));

    return entries.sort((a, b) => a.at - b.at);
}

export const getSessions = (entries: TimelineEntry[]) => entries.flatMap(entry => entry.kind === "session" ? [entry.session] : []);

export interface Contact extends VoicePeer {
    callMs: number;
    chatMs: number;
    turns: number;
    /** Times they shared a call. */
    calls: number;
    lastAt: number;
}

/** Ranks people by time in calls with the user plus time in back-and-forth conversations. */
export function computeContacts(logs: ActivityLog[], now = Date.now()): Contact[] {
    const totals = new Map<string, Contact>();
    const together = new Map<string, { name: string; since: number; }>();

    const total = (id: string, name: string) => {
        const contact = totals.get(id) ?? { id, name, callMs: 0, chatMs: 0, turns: 0, calls: 0, lastAt: 0 };
        contact.name = name;
        totals.set(id, contact);
        return contact;
    };

    function part(id: string, at: number) {
        const peer = together.get(id);
        if (!peer) return;

        together.delete(id);

        const contact = total(id, peer.name);
        contact.callMs += at - peer.since;
        contact.calls++;
        contact.lastAt = Math.max(contact.lastAt, at);
    }

    const partAll = (at: number) => [...together.keys()].forEach(id => part(id, at));

    for (const log of logs) {
        if (log.type === "voice" && log.voiceChannel) {
            partAll(log.timestamp);
            if (log.voiceChannel.action === "leave") continue;
            for (const { id, name } of log.voiceChannel.present ?? []) together.set(id, { name, since: log.timestamp });
        } else if (log.type === "contact" && log.contact) {
            if (log.contact.action === "joined") together.set(log.contact.userId, { name: log.contact.name, since: log.timestamp });
            else part(log.contact.userId, log.timestamp);
        } else if (log.type === "chat" && log.chat) {
            const contact = total(log.chat.userId, log.chat.name);
            contact.chatMs += log.chat.endedAt - log.chat.startedAt;
            contact.turns += log.chat.turns;
            contact.lastAt = Math.max(contact.lastAt, log.chat.endedAt);
        }
    }

    partAll(now);

    return [...totals.values()].sort((a, b) => b.callMs + b.chatMs - a.callMs - a.chatMs);
}

export interface DayRow {
    date: Date;
    /** Parts of the day spent in calls, as fractions from 0 to 1. */
    calls: { start: number; end: number; label: string; }[];
    /** Moments with messages, as fractions from 0 to 1. */
    messages: number[];
}

/** One row per day, newest first, for drawing each day as a line from midnight to midnight. */
export function buildDayRows(logs: ActivityLog[], sessions: VoiceSession[], days: number, now = Date.now()): DayRow[] {
    const rows: DayRow[] = [];
    const today = new Date(now);
    today.setHours(0, 0, 0, 0);

    for (let i = 0; i < days; i++) {
        const date = new Date(today);
        date.setDate(today.getDate() - i);

        const start = date.getTime();
        const next = new Date(date);
        next.setDate(date.getDate() + 1);
        const end = next.getTime();
        const fraction = (time: number) => (Math.min(Math.max(time, start), end) - start) / (end - start);

        rows.push({
            date,
            calls: sessions
                .filter(session => session.startedAt < end && (session.endedAt ?? now) > start)
                .map(session => ({
                    start: fraction(session.startedAt),
                    end: fraction(session.endedAt ?? now),
                    label: session.place.channelName
                })),
            messages: logs
                .filter(log => log.type === "message" && log.timestamp >= start && log.timestamp < end)
                .map(log => fraction(log.timestamp))
        });
    }

    return rows;
}

export function logsSince(logs: ActivityLog[], days: number | null, now = Date.now()): ActivityLog[] {
    if (days == null) return logs;

    const from = now - days * DAY_MS;
    return logs.filter(log => log.timestamp >= from);
}

/** The hour with the most recorded activity. */
export function getBusiestHour(logs: ActivityLog[]): number | null {
    const hours = new Array<number>(24).fill(0);
    logs.forEach(log => hours[new Date(log.timestamp).getHours()]++);

    const peak = Math.max(...hours);
    return peak > 0 ? hours.indexOf(peak) : null;
}

export function formatDuration(ms: number): string {
    const minutes = Math.floor(ms / 60000);
    if (minutes < 1) return "under 1m";

    const hours = Math.floor(minutes / 60);
    if (hours < 1) return `${minutes}m`;

    return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
}

export function formatAgo(time: number, now = Date.now()): string {
    const seconds = Math.max(0, Math.floor((now - time) / 1000));
    if (seconds < 60) return "just now";

    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;

    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;

    return `${Math.floor(hours / 24)}d ago`;
}

export interface Span {
    label: string;
    start: number;
    end: number;
}

/** Periods in each status, from the changes recorded. Time before the first change is unknown. */
export function buildStatusSpans(logs: ActivityLog[], now = Date.now()): Span[] {
    const spans: Span[] = [];

    for (const log of logs) {
        if (log.type !== "status" || !log.status) continue;

        const last = spans[spans.length - 1];
        if (last) last.end = log.timestamp;
        spans.push({ label: log.status.status, start: log.timestamp, end: now });
    }

    return spans;
}

/** Periods with each game or app, ending when it disappears or the person goes offline. */
export function buildActivitySpans(logs: ActivityLog[], now = Date.now()): (Span & { type: number; })[] {
    const spans: (Span & { type: number; })[] = [];
    const open = new Map<string, Span & { type: number; }>();

    const close = (name: string, at: number) => {
        const span = open.get(name);
        if (!span) return;

        open.delete(name);
        spans.push({ ...span, end: at });
    };

    for (const log of logs) {
        if (log.type === "status" && log.status?.status === "offline") {
            [...open.keys()].forEach(name => close(name, log.timestamp));
        } else if (log.type === "activity") {
            const current = (log.activities ?? []).filter(activity => activity.type !== 4);
            const names = new Set(current.map(activity => activity.name));

            [...open.keys()].filter(name => !names.has(name)).forEach(name => close(name, log.timestamp));
            for (const { name, type } of current) {
                if (!open.has(name)) open.set(name, { label: name, type, start: log.timestamp, end: now });
            }
        }
    }

    [...open.keys()].forEach(name => close(name, now));

    return spans.sort((a, b) => a.start - b.start);
}

/** Keeps only the part of each span inside the period. */
export function spansSince<T extends Span>(spans: T[], days: number | null, now = Date.now()): T[] {
    if (days == null) return spans;

    const from = now - days * DAY_MS;
    return spans.filter(span => span.end > from).map(span => ({ ...span, start: Math.max(span.start, from) }));
}

export function sumSpans(spans: Span[]): { label: string; durationMs: number; }[] {
    const totals = new Map<string, number>();
    for (const { label, start, end } of spans) totals.set(label, (totals.get(label) ?? 0) + end - start);

    return [...totals].map(([label, durationMs]) => ({ label, durationMs })).sort((a, b) => b.durationMs - a.durationMs);
}

/** Cuts spans to one stretch of time and turns them into fractions of it. */
export function clipSpans<T extends Span>(spans: T[], start: number, end: number): (T & { from: number; to: number; })[] {
    return spans
        .filter(span => span.start < end && span.end > start)
        .map(span => ({
            ...span,
            from: (Math.max(span.start, start) - start) / (end - start),
            to: (Math.min(span.end, end) - start) / (end - start)
        }));
}

export interface HourBucket {
    messages: number;
    callMs: number;
}

/** Activity by hour of the day, adding every day in the logs together. */
export function hourlyActivity(logs: ActivityLog[], sessions: VoiceSession[], now = Date.now()): HourBucket[] {
    const hours = Array.from({ length: 24 }, (): HourBucket => ({ messages: 0, callMs: 0 }));

    for (const log of logs) {
        if (log.type === "message") hours[new Date(log.timestamp).getHours()].messages++;
    }

    for (const session of sessions) {
        let cursor = session.startedAt;
        const end = session.endedAt ?? now;

        while (cursor < end) {
            const hourEnd = new Date(cursor);
            hourEnd.setHours(hourEnd.getHours() + 1, 0, 0, 0);

            const until = Math.min(hourEnd.getTime(), end);
            hours[new Date(cursor).getHours()].callMs += until - cursor;
            cursor = until;
        }
    }

    return hours;
}

export function rankChannels(logs: ActivityLog[]): { label: string; server?: string; count: number; }[] {
    const channels = new Map<string, { label: string; server?: string; count: number; }>();

    for (const { message } of logs) {
        if (!message) continue;

        const channel = channels.get(message.channelId) ?? { label: message.channelName, server: message.guildName, count: 0 };
        channel.count++;
        channels.set(message.channelId, channel);
    }

    return [...channels.values()].sort((a, b) => b.count - a.count);
}

export function rankEmojis(logs: ActivityLog[]): { emoji: string; count: number; }[] {
    const emojis = new Map<string, number>();

    for (const { reaction } of logs) {
        if (reaction?.added) emojis.set(reaction.emoji, (emojis.get(reaction.emoji) ?? 0) + 1);
    }

    return [...emojis].map(([emoji, count]) => ({ emoji, count })).sort((a, b) => b.count - a.count);
}

/** How often each device appeared in the status changes. */
export function rankPlatforms(logs: ActivityLog[]): { label: string; count: number; }[] {
    const platforms = new Map<string, number>();

    for (const { status } of logs) {
        for (const platform of Object.keys(status?.clientStatus ?? {})) {
            platforms.set(platform, (platforms.get(platform) ?? 0) + 1);
        }
    }

    return [...platforms].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count);
}

/** The logs from the stretch of time just before the current period, for comparing. */
export function previousPeriod(logs: ActivityLog[], days: number | null, now = Date.now()): ActivityLog[] | null {
    if (days == null) return null;

    const end = now - days * DAY_MS;
    const start = end - days * DAY_MS;
    return logs.filter(log => log.timestamp >= start && log.timestamp < end);
}

/** The change from before to now as a whole percentage, or null when there's nothing to compare with. */
export function percentChange(current: number, before: number): number | null {
    return before > 0 ? Math.round((current - before) / before * 100) : null;
}

/** The start of the three hours in a row with the most activity. */
export function getBusiestWindow(logs: ActivityLog[]): number | null {
    const hours = new Array<number>(24).fill(0);
    logs.forEach(log => hours[new Date(log.timestamp).getHours()]++);

    let best = -1;
    let bestStart: number | null = null;

    for (let start = 0; start < 24; start++) {
        const total = hours[start] + hours[(start + 1) % 24] + hours[(start + 2) % 24];
        if (total > best) {
            best = total;
            bestStart = start;
        }
    }

    return best > 0 ? bestStart : null;
}
