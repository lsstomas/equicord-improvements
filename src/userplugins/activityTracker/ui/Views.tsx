/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { React } from "@webpack/common";

import { describeField, describePlace } from "../describe";
import { getInsights } from "../insights";
import { imageUrl, ProfileSnapshot } from "../profileTracking";
import { buildDayRows, Contact, formatAgo, formatDuration, hourlyActivity, percentChange, rankChannels, rankEmojis, rankPlatforms, Span, spansSince, sumSpans, TimelineEntry, VoiceSession } from "../stats";
import { ActivityLog, ProfileChange } from "../types";
import { DayDetail, DayPicker } from "./DayView";
import { Avatar, BarList, cl, dayLabel, Empty, HourChart, Icon, plural, Section, Stats } from "./shared";
import { CallSummary, LogSummary } from "./Timeline";

export interface PeriodData {
    logs: ActivityLog[];
    previous: ActivityLog[] | null;
    entries: TimelineEntry[];
    sessions: VoiceSession[];
    previousCallMs: number;
    contacts: Contact[];
    statusSpans: Span[];
    activitySpans: (Span & { type: number; })[];
    days: number | null;
    now: number;
}

const STATUS_LABELS: Record<string, string> = { online: "Online", idle: "Idle", dnd: "Do not disturb", offline: "Offline" };
const callTotal = (sessions: VoiceSession[]) => sessions.reduce((total, session) => total + session.durationMs, 0);
const countOf = (logs: ActivityLog[] | null | undefined, type: ActivityLog["type"]) => logs?.filter(log => log.type === type).length ?? 0;

function contactList({ contacts }: { contacts: Contact[]; }) {
    return contacts.map(contact => ({
        label: contact.name,
        value: contact.callMs + contact.chatMs,
        display: formatDuration(contact.callMs + contact.chatMs)
    }));
}

export function Overview({ data, showContacts }: { data: PeriodData; showContacts(): void; }) {
    const { logs, previous, sessions, previousCallMs, contacts, statusSpans, activitySpans, days, now } = data;

    const statusTotals = sumSpans(spansSince(statusSpans, days, now));
    const onlineMs = statusTotals.filter(({ label }) => label !== "offline").reduce((total, { durationMs }) => total + durationMs, 0);
    const games = sumSpans(spansSince(activitySpans, days, now).filter(span => span.type === 0));
    const insights = getInsights({ logs, previous, sessions, contacts, games, onlineMs, days });

    const rows = React.useMemo(() => buildDayRows(logs, sessions, Math.min(days ?? 14, 14), now), [logs, sessions, days, now]);
    const [selectedDay, setSelectedDay] = React.useState(rows[0].date.getTime());
    const date = new Date(selectedDay);
    const hours = React.useMemo(() => hourlyActivity(logs, sessions, now), [logs, sessions, now]);

    const messages = countOf(logs, "message");
    const callMs = callTotal(sessions);

    return (
        <>
            <Stats items={[
                { label: "Messages", value: messages.toLocaleString(), change: percentChange(messages, countOf(previous, "message")) },
                { label: "In calls", value: callMs ? formatDuration(callMs) : "None", change: percentChange(callMs, previousCallMs) },
                { label: "Online", value: onlineMs ? formatDuration(onlineMs) : "Unknown" },
                { label: "Closest contact", value: contacts[0]?.name ?? "No one yet" }
            ]} />

            <Section title="What stands out">
                {insights.length
                    ? <ul className={cl("insights")}>{insights.slice(0, 6).map(insight => <li key={insight}>{insight}</li>)}</ul>
                    : <Empty>Patterns appear here after a few days of activity.</Empty>}
            </Section>

            <Section title={selectedDay === rows[0].date.getTime() ? "Today" : dayLabel(selectedDay)}>
                <DayDetail date={date} logs={logs} sessions={sessions} statusSpans={statusSpans} activitySpans={activitySpans} now={now} />
                {rows.length > 1 && <DayPicker rows={rows} selected={selectedDay} onSelect={setSelectedDay} />}
            </Section>

            <div className={cl("columns")}>
                <Section title="Closest contacts" aside={contacts.length > 3 && <button className={cl("link")} onClick={showContacts}>See all</button>}>
                    {contacts.length
                        ? <BarList items={contactList({ contacts: contacts.slice(0, 3) })} />
                        : <Empty>Shared calls and conversations appear here.</Empty>}
                </Section>
                <Section title="Busiest hours">
                    {messages || callMs
                        ? <HourChart hours={hours} show="both" />
                        : <Empty>No messages or calls in this period.</Empty>}
                </Section>
            </div>
        </>
    );
}

export function Messages({ data }: { data: PeriodData; }) {
    const { logs, previous, sessions, now } = data;

    const messages = countOf(logs, "message");
    const edited = countOf(logs, "messageEdit");
    const deleted = countOf(logs, "messageDelete");
    const reactions = logs.filter(log => log.reaction?.added).length;

    const hours = React.useMemo(() => hourlyActivity(logs, sessions, now), [logs, sessions, now]);
    const channels = rankChannels(logs);
    const emojis = rankEmojis(logs);
    const changes = logs.filter(log => log.type === "messageEdit" || log.type === "messageDelete").reverse().slice(0, 8);

    if (!messages && !edited && !deleted && !reactions) return <Empty>No messages or reactions in this period.</Empty>;

    return (
        <>
            <Stats items={[
                { label: "Sent", value: messages.toLocaleString(), change: percentChange(messages, countOf(previous, "message")) },
                { label: "Edited", value: edited.toLocaleString() },
                { label: "Deleted", value: deleted.toLocaleString() },
                { label: "Reactions", value: reactions.toLocaleString() }
            ]} />

            <div className={cl("columns")}>
                <Section title="Where they talk">
                    {channels.length
                        ? <BarList items={channels.slice(0, 6).map(({ label, server, count }) => ({ label: `#${label}`, detail: server, value: count, display: count.toLocaleString() }))} />
                        : <Empty>No messages in this period.</Empty>}
                </Section>
                <Section title="When they talk">
                    <HourChart hours={hours} show="messages" />
                </Section>
            </div>

            {!!emojis.length && (
                <Section title="Favorite reactions">
                    <ul className={cl("emojis")}>
                        {emojis.slice(0, 12).map(({ emoji, count }) => <li key={emoji}><span>{emoji}</span> {count}</li>)}
                    </ul>
                </Section>
            )}

            {!!changes.length && (
                <Section title="Edited and deleted">
                    {changes.map(log => (
                        <div key={log.timestamp} className={cl("row")}>
                            <time className={cl("row-time")}>{new Date(log.timestamp).toLocaleDateString([], { day: "numeric", month: "short" })}</time>
                            <Icon name={log.type === "messageEdit" ? "edit" : "delete"} />
                            <span className={cl("row-body")}><LogSummary log={log} /></span>
                        </div>
                    ))}
                </Section>
            )}
        </>
    );
}

export function Calls({ data }: { data: PeriodData; }) {
    const { logs, sessions, previousCallMs, contacts, now } = data;
    const hours = React.useMemo(() => hourlyActivity(logs, sessions, now), [logs, sessions, now]);

    if (!sessions.length) return <Empty>No calls in this period.</Empty>;

    const total = callTotal(sessions);
    const longest = Math.max(...sessions.map(session => session.durationMs));

    const places = new Map<string, { label: string; detail?: string; value: number; }>();
    for (const { place, durationMs } of sessions) {
        const entry = places.get(place.channelId) ?? { label: place.guildName ? `#${place.channelName}` : describePlace(place), detail: place.guildName, value: 0 };
        entry.value += durationMs;
        places.set(place.channelId, entry);
    }

    const ranked = [...places.values()].sort((a, b) => b.value - a.value).slice(0, 6);
    const partners = contacts.filter(contact => contact.callMs > 0).sort((a, b) => b.callMs - a.callMs).slice(0, 6);

    return (
        <>
            <Stats items={[
                { label: "Time in calls", value: formatDuration(total), change: percentChange(total, previousCallMs) },
                { label: "Calls", value: sessions.length.toLocaleString() },
                { label: "Average", value: formatDuration(total / sessions.length) },
                { label: "Longest", value: formatDuration(longest) }
            ]} />

            <div className={cl("columns")}>
                <Section title="Where">
                    <BarList items={ranked.map(place => ({ ...place, display: formatDuration(place.value) }))} />
                </Section>
                <Section title="With whom">
                    {partners.length
                        ? <BarList items={partners.map(({ name, callMs }) => ({ label: name, value: callMs, display: formatDuration(callMs) }))} />
                        : <Empty>Nobody else was recorded in these calls.</Empty>}
                </Section>
            </div>

            <Section title="When">
                <HourChart hours={hours} show="calls" />
            </Section>

            <Section title="Every call">
                {[...sessions].reverse().slice(0, 30).map(session => (
                    <div key={session.startedAt} className={cl("row")}>
                        <time className={cl("row-time")}>{new Date(session.startedAt).toLocaleDateString([], { day: "numeric", month: "short" })}</time>
                        <Icon name="call" />
                        <span className={cl("row-body")}><CallSummary session={session} /></span>
                    </div>
                ))}
            </Section>
        </>
    );
}

export function Contacts({ data, onOpen }: { data: PeriodData; onOpen(contact: Contact): void; }) {
    const { contacts } = data;

    if (!contacts.length) return <Empty>Shared calls and conversations appear here. A conversation counts after a few replies back and forth.</Empty>;

    const total = contacts.reduce((sum, contact) => sum + contact.callMs + contact.chatMs, 0);
    const largest = contacts[0].callMs + contacts[0].chatMs;

    return (
        <>
            <div className={cl("legend")}>
                <span><i className={cl("legend-call")} />In calls</span>
                <span><i className={cl("legend-chat")} />Chatting</span>
            </div>
            <ol className={cl("contacts")}>
                {contacts.map(contact => {
                    const time = contact.callMs + contact.chatMs;
                    const details = [
                        contact.calls && plural(contact.calls, "shared call"),
                        contact.turns && plural(contact.turns, "reply").replace("replys", "replies"),
                        contact.lastAt && `last together ${formatAgo(contact.lastAt)}`
                    ].filter(Boolean);

                    return (
                        <li key={contact.id}>
                            <button className={cl("contact")} onClick={() => onOpen(contact)}>
                                <Avatar userId={contact.id} name={contact.name} size={36} />
                                <span className={cl("contact-body")}>
                                    <span className={cl("contact-head")}>
                                        <span className={cl("contact-name")}>{contact.name}</span>
                                        <span className={cl("contact-total")}>{formatDuration(time)}</span>
                                        <span className={cl("contact-share")}>{Math.round(time / total * 100)}%</span>
                                    </span>
                                    <span className={cl("contact-bar")} aria-hidden="true">
                                        <span className={cl("contact-call")} style={{ width: `${contact.callMs / largest * 100}%` }} />
                                        <span className={cl("contact-chat")} style={{ width: `${contact.chatMs / largest * 100}%` }} />
                                    </span>
                                    <span className={cl("contact-detail")}>{details.join(", ")}</span>
                                </span>
                            </button>
                        </li>
                    );
                })}
            </ol>
        </>
    );
}

export function Presence({ data }: { data: PeriodData; }) {
    const { logs, days, now } = data;
    const statusSpans = spansSince(data.statusSpans, days, now);
    const activitySpans = spansSince(data.activitySpans, days, now);

    const statusTotals = sumSpans(statusSpans);
    const statusMs = statusTotals.reduce((total, { durationMs }) => total + durationMs, 0);
    const games = sumSpans(activitySpans.filter(span => span.type === 0));
    const music = sumSpans(activitySpans.filter(span => span.type === 2));
    const platforms = rankPlatforms(logs);
    const platformTotal = platforms.reduce((total, { count }) => total + count, 0);

    if (!statusTotals.length && !games.length && !music.length) return <Empty>Status changes and games appear here.</Empty>;

    return (
        <>
            {!!statusTotals.length && (
                <Section title="Time by status">
                    <div className={cl("share")} role="img" aria-label={statusTotals.map(({ label, durationMs }) => `${STATUS_LABELS[label] ?? label} ${formatDuration(durationMs)}`).join(", ")}>
                        {statusTotals.map(({ label, durationMs }) => <span key={label} data-kind={label} style={{ width: `${durationMs / statusMs * 100}%` }} />)}
                    </div>
                    <ul className={cl("share-legend")}>
                        {statusTotals.map(({ label, durationMs }) => (
                            <li key={label}>
                                <i data-kind={label} />
                                <span>{STATUS_LABELS[label] ?? label}</span>
                                <strong>{formatDuration(durationMs)}</strong>
                            </li>
                        ))}
                    </ul>
                </Section>
            )}

            <div className={cl("columns")}>
                <Section title="Games">
                    {games.length
                        ? <BarList items={games.slice(0, 6).map(({ label, durationMs }) => ({ label, value: durationMs, display: formatDuration(durationMs) }))} />
                        : <Empty>No games in this period.</Empty>}
                </Section>
                <Section title="Devices">
                    {platforms.length
                        ? <BarList items={platforms.map(({ label, count }) => ({ label: label[0].toUpperCase() + label.slice(1), value: count, display: `${Math.round(count / platformTotal * 100)}%` }))} />
                        : <Empty>Devices appear with the next status change.</Empty>}
                </Section>
            </div>

            {!!music.length && (
                <Section title="Music">
                    <BarList items={music.slice(0, 4).map(({ label, durationMs }) => ({ label, value: durationMs, display: formatDuration(durationMs) }))} />
                </Section>
            )}
        </>
    );
}

function ProfileValue({ userId, change, value }: { userId: string; change: ProfileChange; value?: string; }) {
    if (!value) return <span className={cl("profile-none")}>None</span>;
    if (change.field === "avatar" || change.field === "banner") {
        return <img className={cl("profile-image")} data-kind={change.field} src={imageUrl(change.field, userId, value, 160)} alt={`${change.field} version`} />;
    }
    return <span className={cl("profile-text")}>{value}</span>;
}

export function ProfileHistory({ userId, logs, profile }: { userId: string; logs: ActivityLog[]; profile?: ProfileSnapshot; }) {
    const versions = logs.filter(log => log.profile && !log.profile.first).reverse();
    const started = logs.find(log => log.profile?.first);

    const current = [
        ["Display name", profile?.globalName],
        ["Username", profile?.username],
        ["Pronouns", profile?.pronouns],
        ["Bio", profile?.bio]
    ].filter(([, value]) => value);

    return (
        <>
            {!!current.length && (
                <Section title="Current profile">
                    <dl className={cl("profile-current")}>
                        {current.map(([label, value]) => (
                            <div key={label!}>
                                <dt>{label}</dt>
                                <dd>{value}</dd>
                            </div>
                        ))}
                    </dl>
                </Section>
            )}

            <Section title="Changes">
                {!versions.length && <Empty>No changes yet. Bios update when their profile is opened.</Empty>}
                <ol className={cl("versions")}>
                    {versions.map(log => (
                        <li key={log.timestamp} className={cl("version")}>
                            <h4 className={cl("version-date")}>{new Date(log.timestamp).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}</h4>
                            {log.profile!.changes.map((change, index) => (
                                <div key={index} className={cl("change")}>
                                    <span className={cl("change-field")}>{describeField(change)}</span>
                                    <div className={cl("change-values")}>
                                        <ProfileValue userId={userId} change={change} value={change.before} />
                                        <span className={cl("change-arrow")} aria-label="changed to">›</span>
                                        <ProfileValue userId={userId} change={change} value={change.after} />
                                    </div>
                                </div>
                            ))}
                        </li>
                    ))}
                </ol>
                {started && <p className={cl("row-note")}>Tracking started {new Date(started.timestamp).toLocaleDateString()}. Earlier changes aren't known.</p>}
            </Section>
        </>
    );
}
