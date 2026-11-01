/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { React, UserStore } from "@webpack/common";

import { HourBucket } from "../stats";

export const cl = (name: string) => `vc-at-${name}`;

export const clock = (time: number) => new Date(time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
export const clockSeconds = (time: number) => new Date(time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
export const dayLabel = (time: number) => new Date(time).toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" });
export const plural = (count: number, word: string) => `${count.toLocaleString()} ${word}${count === 1 ? "" : "s"}`;

export function Avatar({ userId, name, size }: { userId: string; name: string; size: number; }) {
    const user = UserStore.getUser(userId);
    const [failed, setFailed] = React.useState(false);
    const style = { width: size, height: size };

    if (!user || failed) return <span className={cl("avatar-fallback")} style={{ ...style, fontSize: size * 0.42 }} aria-hidden="true">{name.slice(0, 1).toUpperCase()}</span>;
    return <img className={cl("avatar")} src={user.getAvatarURL(void 0, size * 2, false)} style={style} alt="" onError={() => setFailed(true)} />;
}

export function Empty({ children }: { children: React.ReactNode; }) {
    return <p className={cl("empty")}>{children}</p>;
}

export function Section({ title, aside, children }: { title: string; aside?: React.ReactNode; children: React.ReactNode; }) {
    return (
        <section className={cl("section")}>
            <div className={cl("section-head")}>
                <h3 className={cl("heading")}>{title}</h3>
                {aside}
            </div>
            {children}
        </section>
    );
}

export interface Stat {
    value: string;
    label: string;
    /** Percentage against the previous period. */
    change?: number | null;
}

export function Stats({ items }: { items: Stat[]; }) {
    return (
        <dl className={cl("stats")}>
            {items.map(({ value, label, change }) => (
                <div key={label} className={cl("stat")}>
                    <dt>{label}</dt>
                    <dd title={value}>{value}</dd>
                    {change != null && change !== 0 && (
                        <p className={cl("stat-change")} data-trend={change > 0 ? "up" : "down"}>
                            {change > 0 ? "Up" : "Down"} {Math.abs(change)}%
                        </p>
                    )}
                </div>
            ))}
        </dl>
    );
}

export function BarList({ items }: { items: { label: string; detail?: string; value: number; display: string; }[]; }) {
    const largest = Math.max(...items.map(item => item.value), 1);

    return (
        <ul className={cl("bars")}>
            {items.map(({ label, detail, value, display }) => (
                <li key={`${label}-${detail}`}>
                    <span className={cl("bar-label")}>
                        <span className={cl("bar-name")}>{label}{detail && <small>{detail}</small>}</span>
                        <span className={cl("bar-value")}>{display}</span>
                    </span>
                    <span className={cl("bar")}><span style={{ width: `${value / largest * 100}%` }} /></span>
                </li>
            ))}
        </ul>
    );
}

/** Each hour of the day as a column, so the shape of someone's day is visible at once. */
export function HourChart({ hours, show }: { hours: HourBucket[]; show: "both" | "messages" | "calls"; }) {
    const total = (hour: HourBucket) => (show === "calls" ? 0 : hour.messages * 60_000) + (show === "messages" ? 0 : hour.callMs);
    const largest = Math.max(...hours.map(total), 1);

    return (
        <div className={cl("hours")} role="img" aria-label="Activity by hour of the day">
            {hours.map((hour, index) => {
                const callPart = show === "messages" ? 0 : hour.callMs / largest * 100;
                const messagePart = show === "calls" ? 0 : hour.messages * 60_000 / largest * 100;
                const parts = [
                    show !== "calls" && plural(hour.messages, "message"),
                    show !== "messages" && `${Math.round(hour.callMs / 60_000)}m in calls`
                ].filter(Boolean);

                return (
                    <div key={index} className={cl("hour")} title={`${String(index).padStart(2, "0")}:00, ${parts.join(", ")}`}>
                        <span className={cl("hour-track")}>
                            <span className={cl("hour-message")} style={{ height: `${messagePart}%` }} />
                            <span className={cl("hour-call")} style={{ height: `${callPart}%` }} />
                        </span>
                        <span className={cl("hour-label")}>{index % 6 ? "" : String(index).padStart(2, "0")}</span>
                    </div>
                );
            })}
        </div>
    );
}

const ICON_PATHS: Record<string, string> = {
    message: "M4 5h16v11H9l-5 4V5Z",
    edit: "M4 20h4L19 9l-4-4L4 16v4ZM13 7l4 4",
    delete: "M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13",
    call: "M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a1 1 0 0 1-1 1A15 15 0 0 1 4 5a1 1 0 0 1 1-1Z",
    voice: "M12 4a3 3 0 0 0-3 3v5a3 3 0 0 0 6 0V7a3 3 0 0 0-3-3ZM6 11a6 6 0 0 0 12 0M12 17v3",
    people: "M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM3 20a6 6 0 0 1 12 0M16 5a3 3 0 0 1 0 6M18 14a6 6 0 0 1 3 6",
    reaction: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM9 10h.01M15 10h.01M8 14a5 5 0 0 0 8 0",
    typing: "M3 7h18v10H3zM7 11h.01M11 11h.01M15 11h.01M8 14h8",
    status: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z",
    game: "M7 8h10a5 5 0 0 1 4.8 6.3 2.5 2.5 0 0 1-4.3 1L15 13H9l-2.5 2.3a2.5 2.5 0 0 1-4.3-1A5 5 0 0 1 7 8ZM8 10v2M7 11h2M15 11h.01M17 11h.01",
    profile: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM5 21a7 7 0 0 1 14 0"
};

export function Icon({ name }: { name: string; }) {
    return (
        <svg className={cl("icon")} data-icon={name} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d={ICON_PATHS[name]} />
        </svg>
    );
}
