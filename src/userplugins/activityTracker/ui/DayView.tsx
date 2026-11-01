/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { React } from "@webpack/common";

import { clipSpans, DayRow, formatDuration, Span, VoiceSession } from "../stats";
import { ActivityLog } from "../types";
import { cl, clock, plural } from "./shared";

const DAY_MS = 86_400_000;

interface Lane {
    label: string;
    kind: string;
    spans: (Span & { from: number; to: number; })[];
}

function DayLane({ label, kind, spans }: Lane) {
    return (
        <div className={cl("lane")}>
            <span className={cl("lane-label")}>{label}</span>
            <div className={cl("lane-track")}>
                {spans.map((span, index) => (
                    <span
                        key={index}
                        className={cl("lane-span")}
                        data-kind={kind === "status" ? span.label : kind}
                        title={`${span.label}, ${clock(span.start)} to ${clock(span.end)}, ${formatDuration(span.end - span.start)}`}
                        style={{ left: `${span.from * 100}%`, width: `max(4px, ${(span.to - span.from) * 100}%)` }}
                    />
                ))}
            </div>
        </div>
    );
}

/** One day split into lanes, to see how status, games, calls and messages overlap. */
export function DayDetail({ date, logs, sessions, statusSpans, activitySpans, now }: {
    date: Date; logs: ActivityLog[]; sessions: VoiceSession[]; statusSpans: Span[]; activitySpans: Span[]; now: number;
}) {
    const start = date.getTime();
    const end = start + DAY_MS;

    const calls = sessions.map(session => ({ label: session.place.channelName, start: session.startedAt, end: session.endedAt ?? now }));
    const messages = logs.filter(log => log.type === "message" && log.timestamp >= start && log.timestamp < end);
    const nowPosition = now >= start && now < end ? (now - start) / DAY_MS : null;

    return (
        <div className={cl("lanes")}>
            <div className={cl("lane-axis")} aria-hidden="true">
                {[0, 6, 12, 18].map(hour => <span key={hour}>{String(hour).padStart(2, "0")}:00</span>)}
            </div>
            <div className={cl("lane-body")}>
                {nowPosition != null && <span className={cl("lane-now")} style={{ left: `calc(72px + (100% - 72px) * ${nowPosition})` }} title="Now" />}
                <DayLane label="Status" kind="status" spans={clipSpans(statusSpans, start, end)} />
                <DayLane label="Games" kind="game" spans={clipSpans(activitySpans, start, end)} />
                <DayLane label="Calls" kind="call" spans={clipSpans(calls, start, end)} />
                <div className={cl("lane")}>
                    <span className={cl("lane-label")}>Messages</span>
                    <div className={cl("lane-track")} aria-label={plural(messages.length, "message")}>
                        {messages.map(log => (
                            <span
                                key={log.timestamp}
                                className={cl("lane-tick")}
                                title={clock(log.timestamp)}
                                style={{ left: `${(log.timestamp - start) / DAY_MS * 100}%` }}
                            />
                        ))}
                    </div>
                </div>
            </div>
        </div>
    );
}

/** Recent days, one line each. Choosing a day shows it in detail. */
export function DayPicker({ rows, selected, onSelect }: { rows: DayRow[]; selected: number; onSelect(time: number): void; }) {
    const dayName = (date: Date) => date.toLocaleDateString([], { weekday: "short", day: "numeric" });

    return (
        <div className={cl("ribbon")}>
            {rows.map(row => {
                const time = row.date.getTime();

                return (
                    <button
                        key={time}
                        className={cl("ribbon-row")}
                        aria-pressed={time === selected}
                        aria-label={`${dayName(row.date)}: ${plural(row.calls.length, "call")} and ${plural(row.messages.length, "message")}`}
                        onClick={() => onSelect(time)}
                    >
                        <span className={cl("ribbon-day")}>{dayName(row.date)}</span>
                        <span className={cl("ribbon-track")}>
                            {row.calls.map((call, index) => (
                                <span key={index} className={cl("ribbon-call")} style={{ left: `${call.start * 100}%`, width: `max(3px, ${(call.end - call.start) * 100}%)` }} />
                            ))}
                            {row.messages.map((position, index) => (
                                <span key={index} className={cl("ribbon-message")} style={{ left: `${position * 100}%` }} />
                            ))}
                        </span>
                    </button>
                );
            })}
        </div>
    );
}
