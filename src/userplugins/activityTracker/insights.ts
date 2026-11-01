/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Contact, formatDuration, getBusiestWindow, percentChange, rankChannels, VoiceSession } from "./stats";
import { ActivityLog } from "./types";

const MIN_EVENTS_FOR_PATTERN = 10;
const MIN_MESSAGES_TO_COMPARE = 5;
const MIN_CONTACT_MS = 10 * 60 * 1000;

interface InsightData {
    logs: ActivityLog[];
    previous: ActivityLog[] | null;
    sessions: VoiceSession[];
    contacts: Contact[];
    games: { label: string; durationMs: number; }[];
    onlineMs: number;
    days: number | null;
}

const hourLabel = (hour: number) => `${String(hour % 24).padStart(2, "0")}:00`;

/** Plain sentences about what stands out. Each one only appears with enough data to mean something. */
export function getInsights({ logs, previous, sessions, contacts, games, onlineMs, days }: InsightData): string[] {
    const insights: string[] = [];
    const messages = logs.filter(log => log.type === "message").length;

    const previousMessages = previous?.filter(log => log.type === "message").length ?? 0;
    const change = previousMessages >= MIN_MESSAGES_TO_COMPARE ? percentChange(messages, previousMessages) : null;
    if (change) insights.push(`Sent ${Math.abs(change)}% ${change > 0 ? "more" : "fewer"} messages than the previous ${days} days`);

    if (logs.length >= MIN_EVENTS_FOR_PATTERN) {
        const start = getBusiestWindow(logs);
        if (start != null) insights.push(`Most active between ${hourLabel(start)} and ${hourLabel(start + 3)}`);
    }

    const contactMs = contacts.reduce((total, contact) => total + contact.callMs + contact.chatMs, 0);
    const top = contacts[0];
    if (top && contacts.length > 1 && contactMs >= MIN_CONTACT_MS) {
        insights.push(`${Math.round((top.callMs + top.chatMs) / contactMs * 100)}% of time with others was with ${top.name}`);
    }

    const [channel] = rankChannels(logs);
    if (channel && messages >= MIN_MESSAGES_TO_COMPARE) {
        insights.push(`${Math.round(channel.count / messages * 100)}% of messages were in #${channel.label}`);
    }

    const deleted = logs.filter(log => log.type === "messageDelete").length;
    if (deleted) insights.push(`Deleted ${deleted} ${deleted === 1 ? "message" : "messages"}`);

    if (sessions.length >= 3) {
        const total = sessions.reduce((sum, session) => sum + session.durationMs, 0);
        insights.push(`Calls last ${formatDuration(total / sessions.length)} on average`);
    }

    if (games[0]) insights.push(`Played ${games[0].label} for ${formatDuration(games[0].durationMs)}`);
    if (onlineMs && days && days > 1) insights.push(`Online about ${formatDuration(onlineMs / days)} a day`);

    return insights;
}
