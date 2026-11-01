/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { React } from "@webpack/common";

import { describeLog, describePlace, getLogPlace, getMessageLink } from "../describe";
import { formatDuration, TimelineEntry, VoiceSession } from "../stats";
import { ActivityLog } from "../types";
import { cl, clock, clockSeconds, dayLabel, Empty, Icon, plural } from "./shared";

const PAGE_SIZE = 60;

const ICONS: Record<ActivityLog["type"], string> = {
    message: "message",
    messageEdit: "edit",
    messageDelete: "delete",
    voice: "call",
    voiceState: "voice",
    contact: "people",
    chat: "people",
    reaction: "reaction",
    typing: "typing",
    status: "status",
    activity: "game",
    profile: "profile"
};

const isLog = (entry: TimelineEntry, ...types: ActivityLog["type"][]) => entry.kind === "log" && types.includes(entry.log.type);

const FILTERS: { id: string; label: string; matches(entry: TimelineEntry): boolean; }[] = [
    { id: "all", label: "Everything", matches: () => true },
    { id: "messages", label: "Messages", matches: entry => isLog(entry, "message") },
    { id: "changes", label: "Edited and deleted", matches: entry => isLog(entry, "messageEdit", "messageDelete") },
    { id: "calls", label: "Calls", matches: entry => entry.kind === "session" || isLog(entry, "voiceState", "contact") },
    { id: "reactions", label: "Reactions", matches: entry => isLog(entry, "reaction") },
    { id: "typing", label: "Typing", matches: entry => isLog(entry, "typing") },
    { id: "presence", label: "Status and games", matches: entry => isLog(entry, "status", "activity") },
    { id: "profile", label: "Profile", matches: entry => isLog(entry, "profile") }
];

export function CallSummary({ session }: { session: VoiceSession; }) {
    const end = session.endedAt ? clock(session.endedAt) : "now";

    return (
        <>
            <p className={cl("row-text")}>
                {clock(session.startedAt)} to {end}
                <span className={cl("row-duration")}>{session.approximate ? "about " : ""}{formatDuration(session.durationMs)}</span>
            </p>
            <p className={cl("row-place")}>{describePlace(session.place)}</p>
            {!!session.present?.length && <p className={cl("row-note")}>With {session.present.map(peer => peer.name).join(", ")}</p>}
        </>
    );
}

export function LogSummary({ log }: { log: ActivityLog; }) {
    const place = getLogPlace(log);
    const { messageEdit, messageDelete, reaction, message } = log;

    return (
        <>
            {messageEdit ? (
                <p className={cl("row-text")}>
                    {messageEdit.before !== undefined && <del>{messageEdit.before}</del>}
                    <ins>{messageEdit.after}</ins>
                </p>
            ) : messageDelete ? (
                <p className={cl("row-text")}><del>{messageDelete.content ?? "Text wasn't recorded"}</del></p>
            ) : (
                <p className={cl("row-text")}>{describeLog(log)}</p>
            )}
            {place && <p className={cl("row-place")}>{describePlace(place)}</p>}
            {reaction?.targetContent && <p className={cl("row-note")}>On: {reaction.targetContent}</p>}
            {message?.replyTo && <p className={cl("row-note")}>Replied to {message.replyTo}</p>}
            {!!message?.mentions?.length && <p className={cl("row-note")}>Mentioned {message.mentions.join(", ")}</p>}
        </>
    );
}

function Row({ entry, onJump }: { entry: TimelineEntry; onJump(link: string): void; }) {
    const link = entry.kind === "log" ? getMessageLink(entry.log) : undefined;
    const icon = entry.kind === "session" ? "call" : ICONS[entry.log.type];
    const content = (
        <>
            <time className={cl("row-time")} dateTime={new Date(entry.at).toISOString()} title={new Date(entry.at).toLocaleString()}>{clockSeconds(entry.at)}</time>
            <Icon name={icon} />
            <span className={cl("row-body")}>
                {entry.kind === "session" ? <CallSummary session={entry.session} /> : <LogSummary log={entry.log} />}
            </span>
        </>
    );

    return link
        ? <button className={cl("row")} data-link="true" title="Go to this message" onClick={() => onJump(link)}>{content}</button>
        : <div className={cl("row")}>{content}</div>;
}

export function Timeline({ entries, onJump }: { entries: TimelineEntry[]; onJump(link: string): void; }) {
    const [filter, setFilter] = React.useState("all");
    const [query, setQuery] = React.useState("");
    const [limit, setLimit] = React.useState(PAGE_SIZE);

    const matching = React.useMemo(() => {
        const search = query.trim().toLowerCase();
        const { matches } = FILTERS.find(item => item.id === filter)!;

        return entries.filter(entry => {
            if (!matches(entry)) return false;
            if (!search) return true;

            const text = entry.kind === "session"
                ? `call ${describePlace(entry.session.place)} ${entry.session.present?.map(peer => peer.name).join(" ")}`
                : `${describeLog(entry.log)} ${entry.log.messageEdit?.before ?? ""} ${getLogPlace(entry.log) ? describePlace(getLogPlace(entry.log)!) : ""}`;
            return text.toLowerCase().includes(search);
        }).reverse();
    }, [entries, filter, query]);

    const visible = matching.slice(0, limit);

    return (
        <>
            <div className={cl("timeline-tools")}>
                <input
                    className={cl("search")}
                    type="search"
                    aria-label="Search this timeline"
                    placeholder={`Search ${plural(entries.length, "entry").replace("entrys", "entries")}`}
                    value={query}
                    onChange={event => { setQuery(event.currentTarget.value); setLimit(PAGE_SIZE); }}
                />
                <div className={cl("chips")} role="group" aria-label="Filter by type">
                    {FILTERS.map(item => (
                        <button key={item.id} className={cl("chip")} aria-pressed={item.id === filter} onClick={() => { setFilter(item.id); setLimit(PAGE_SIZE); }}>
                            {item.label}
                        </button>
                    ))}
                </div>
            </div>

            {!visible.length && <Empty>Nothing here for this filter and period.</Empty>}

            {visible.map((entry, index) => {
                const day = dayLabel(entry.at);

                return (
                    <React.Fragment key={`${entry.at}-${index}`}>
                        {(!index || day !== dayLabel(visible[index - 1].at)) && <h3 className={cl("day")}>{day}</h3>}
                        <Row entry={entry} onJump={onJump} />
                    </React.Fragment>
                );
            })}

            {matching.length > visible.length && <button className={cl("more")} onClick={() => setLimit(limit + PAGE_SIZE)}>Show older entries</button>}
        </>
    );
}
