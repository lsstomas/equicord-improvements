/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import { openUserProfile } from "@utils/discord";
import { Alerts, ChannelStore, Modal, NavigationRouter, PresenceStore, React, Select, UserStore, VoiceStateStore } from "@webpack/common";

import { describeLog, describePlace, getLogPlace } from "../describe";
import { PEOPLE_SORTS, PeopleSort, PersonInfo, sortPeople } from "../people";
import { settings } from "../settings";
import { buildActivitySpans, buildStatusSpans, computeContacts, Contact, formatAgo, formatDuration, getSessions, logsSince, pairVoiceSessions, previousPeriod } from "../stats";
import { clearAll, history, profiles, setTracked, subscribeTracked, trackedUserIds } from "../store";
import { ActivityLog } from "../types";
import { Avatar, cl } from "./shared";
import { Timeline } from "./Timeline";
import { Calls, Contacts, Messages, Overview, PeriodData, Presence, ProfileHistory } from "./Views";

type View = "overview" | "timeline" | "messages" | "calls" | "contacts" | "presence" | "profile";

const VIEWS: { id: View; label: string; }[] = [
    { id: "overview", label: "Overview" },
    { id: "timeline", label: "Timeline" },
    { id: "messages", label: "Messages" },
    { id: "calls", label: "Calls" },
    { id: "contacts", label: "Contacts" },
    { id: "presence", label: "Status and games" },
    { id: "profile", label: "Profile" }
];

const DIALOG_WIDTH = 1080;

const PERIODS: { label: string; days: number | null; }[] = [
    { label: "24h", days: 1 },
    { label: "7d", days: 7 },
    { label: "30d", days: 30 },
    { label: "All", days: null }
];

export function RadarIcon({ height = 24, width = 24 }: { height?: number; width?: number; }) {
    return (
        <svg width={width} height={height} viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" />
            <circle cx="12" cy="12" r="4.5" stroke="currentColor" strokeWidth="1.5" opacity="0.55" />
            <path d="M12 12 18.36 5.64A9 9 0 0 1 21 12Z" fill="currentColor" opacity="0.35" />
            <path d="M12 12 18.36 5.64" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
    );
}

/**
 * Discord's largest modal size has no fixed width we can rely on, and its classes change with every
 * update. So this finds the visible card around the dashboard, which is the outermost parent with
 * both a background and rounded corners, and sizes that.
 */
function fitDialog(shell: HTMLElement) {
    let card: HTMLElement | undefined;

    for (let node = shell.parentElement; node && node !== document.body; node = node.parentElement) {
        const { backgroundColor, borderTopLeftRadius } = getComputedStyle(node);
        const hasBackground = backgroundColor !== "transparent" && backgroundColor !== "rgba(0, 0, 0, 0)";

        if (hasBackground && parseFloat(borderTopLeftRadius) > 0) card = node;
    }

    if (!card) return;

    card.style.width = `min(${DIALOG_WIDTH}px, 92vw)`;
    card.style.maxWidth = "none";
    card.style.marginInline = "auto";
}

function useMinuteTick() {
    const [tick, advance] = React.useReducer((count: number) => count + 1, 0);

    React.useEffect(() => {
        const timer = setInterval(advance, 30_000);
        return () => clearInterval(timer);
    }, []);

    return tick;
}

function getLiveLine(userId: string): string {
    const voice = VoiceStateStore.getVoiceStateForUser(userId);
    if (voice?.channelId) return "In a call";

    const activity = (PresenceStore.getActivities(userId) ?? []).find(item => item.type !== 4);
    if (activity) return activity.name;

    const status = PresenceStore.getStatus(userId);
    return status === "offline" || !status ? "Offline" : status === "dnd" ? "Do not disturb" : status === "idle" ? "Idle" : "Online";
}

/** What the person is doing right now, in one sentence. */
function getRightNow(userId: string, sessions: PeriodData["sessions"]): string {
    const channelId = VoiceStateStore.getVoiceStateForUser(userId)?.channelId;

    if (channelId) {
        const name = ChannelStore.getChannel(channelId)?.name;
        const current = sessions[sessions.length - 1];
        const duration = current?.endedAt == null && current ? ` for ${formatDuration(current.durationMs)}` : "";
        return `In ${name ? `#${name}` : "a call"}${duration}`;
    }

    return getLiveLine(userId);
}

function PersonRow({ person, selected, onSelect }: { person: PersonInfo; selected: boolean; onSelect(): void; }) {
    const { id, name, status, lastAt } = person;

    return (
        <button className={cl("person")} aria-current={selected ? "true" : undefined} onClick={onSelect}>
            <span className={cl("person-avatar")}>
                <Avatar userId={id} name={name} size={32} />
                <span className={cl("status")} data-status={status} />
            </span>
            <span className={cl("person-text")}>
                <span className={cl("person-name")}>{name}</span>
                <span className={cl("person-line")}>{getLiveLine(id)}{lastAt ? `, ${formatAgo(lastAt)}` : ""}</span>
            </span>
        </button>
    );
}

function downloadFile(name: string, text: string, type: string) {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    link.click();
    URL.revokeObjectURL(url);
}

function exportCsv(logs: ActivityLog[], name: string) {
    const quote = (value: string) => `"${value.replace(/"/g, '""')}"`;
    const rows = logs.map(log => [
        new Date(log.timestamp).toISOString(),
        log.type,
        quote(log.username),
        log.userId,
        quote(describeLog(log)),
        quote(getLogPlace(log) ? describePlace(getLogPlace(log)!) : "")
    ].join(","));

    downloadFile(`activity-${name}.csv`, ["time,type,user,user id,what,where", ...rows].join("\n"), "text/csv");
}

function usePeriodData(logs: ActivityLog[], days: number | null, tick: number): PeriodData {
    return React.useMemo(() => {
        const now = Date.now();
        const inPeriod = logsSince(logs, days, now);
        const previous = previousPeriod(logs, days, now);
        const entries = pairVoiceSessions(inPeriod, now);

        return {
            logs: inPeriod,
            previous,
            entries,
            sessions: getSessions(entries),
            previousCallMs: getSessions(pairVoiceSessions(previous ?? [], now)).reduce((total, session) => total + session.durationMs, 0),
            contacts: computeContacts(inPeriod, now),
            statusSpans: buildStatusSpans(logs, now),
            activitySpans: buildActivitySpans(logs, now),
            days,
            now
        };
    }, [logs, days, tick]);
}

function Person({ userId, logs, onClose, onSelect, tick }: { userId: string; logs: ActivityLog[]; onClose(): void; onSelect(userId: string): void; tick: number; }) {
    const [view, setView] = React.useState<View>("overview");
    const [days, setDays] = React.useState<number | null>(7);
    const isTracked = trackedUserIds.has(userId);

    const user = UserStore.getUser(userId);
    const name = user?.globalName ?? user?.username ?? logs[0]?.username ?? userId;
    const data = usePeriodData(logs, days, tick);

    function jump(link: string) {
        onClose();
        NavigationRouter.transitionTo(link);
    }

    function openContact(contact: Contact) {
        if (trackedUserIds.has(contact.id)) onSelect(contact.id);
        else openUserProfile(contact.id);
    }

    return (
        <main className={cl("main")}>
            <header className={cl("person-head")}>
                <Avatar userId={userId} name={name} size={48} />
                <div className={cl("person-title")}>
                    <h2>{name}</h2>
                    <p>{getRightNow(userId, data.sessions)}</p>
                </div>
                <div className={cl("actions")}>
                    <button className={cl("button")} onClick={() => openUserProfile(userId)}>View profile</button>
                    <button className={cl("button")} onClick={() => exportCsv(logs, name)}>Export CSV</button>
                    <button className={cl("button")} data-danger={isTracked || undefined} onClick={() => setTracked(userId, !isTracked)}>
                        {isTracked ? "Stop tracking" : "Start tracking"}
                    </button>
                </div>
            </header>

            <nav className={cl("tabs")} aria-label="Sections">
                {VIEWS.map(item => (
                    <button key={item.id} className={cl("tab")} aria-current={item.id === view ? "page" : undefined} onClick={() => setView(item.id)}>
                        {item.label}
                    </button>
                ))}
                {view !== "profile" && (
                    <div className={cl("periods")} role="group" aria-label="Period">
                        {PERIODS.map(period => (
                            <button key={period.label} className={cl("period")} aria-pressed={period.days === days} onClick={() => setDays(period.days)}>
                                {period.label}
                            </button>
                        ))}
                    </div>
                )}
            </nav>

            <div className={cl("content")}>
                {view === "overview" && <Overview key={days} data={data} showContacts={() => setView("contacts")} />}
                {view === "timeline" && <Timeline entries={data.entries} onJump={jump} />}
                {view === "messages" && <Messages data={data} />}
                {view === "calls" && <Calls data={data} />}
                {view === "contacts" && <Contacts data={data} onOpen={openContact} />}
                {view === "presence" && <Presence data={data} />}
                {view === "profile" && <ProfileHistory userId={userId} logs={logs} profile={profiles.get(userId)} />}
            </div>
        </main>
    );
}

export function ActivityDashboard({ modalProps, initialUserId }: { modalProps: any; initialUserId?: string; }) {
    const logs = React.useSyncExternalStore(history.subscribe, history.getEntries);
    const [, onTrackedChange] = React.useReducer((count: number) => count + 1, 0);
    const [selectedId, setSelectedId] = React.useState<string | undefined>(initialUserId);
    const [search, setSearch] = React.useState("");
    const [sort, setSort] = React.useState(settings.store.sidebarSort as PeopleSort);
    const tick = useMinuteTick();
    const shellRef = React.useRef<HTMLDivElement>(null);

    React.useEffect(() => subscribeTracked(onTrackedChange), []);
    React.useLayoutEffect(() => {
        if (shellRef.current) fitDialog(shellRef.current);
    }, []);

    const byUser = React.useMemo(() => {
        const groups = new Map<string, ActivityLog[]>();
        for (const log of logs) {
            const group = groups.get(log.userId);
            if (group) group.push(log);
            else groups.set(log.userId, [log]);
        }
        return groups;
    }, [logs]);

    const addedOrder = [...trackedUserIds];

    function toPerson(id: string): PersonInfo {
        const user = UserStore.getUser(id);
        return {
            id,
            name: user?.globalName ?? user?.username ?? byUser.get(id)?.[0]?.username ?? id,
            status: PresenceStore.getStatus(id) ?? "offline",
            inCall: !!VoiceStateStore.getVoiceStateForUser(id)?.channelId,
            lastAt: byUser.get(id)?.at(-1)?.timestamp ?? 0,
            addedIndex: addedOrder.indexOf(id)
        };
    }

    const query = search.trim().toLowerCase();
    const list = (ids: string[]) => sortPeople(ids.map(toPerson).filter(person => !query || person.id === query || person.name.toLowerCase().includes(query)), sort);

    const tracked = list(addedOrder);
    const previous = list([...byUser.keys()].filter(id => !trackedUserIds.has(id)));
    const activeId = selectedId ?? tracked[0]?.id ?? previous[0]?.id;

    function changeSort(value: PeopleSort) {
        setSort(value);
        settings.store.sidebarSort = value;
    }

    function confirmClear() {
        Alerts.show({
            title: "Delete everything?",
            body: <p>This deletes all saved activity and stops tracking everyone. Files already copied to Documents stay there.</p>,
            confirmColor: "danger",
            confirmText: "Delete everything",
            cancelText: "Cancel",
            onConfirm: () => {
                setSelectedId(undefined);
                void clearAll();
            }
        });
    }

    return (
        <Modal {...modalProps} size="xxl" title="Activity Tracker">
            <div className={cl("shell")} ref={shellRef}>
                <aside className={cl("sidebar")}>
                    <input
                        className={cl("search")}
                        type="search"
                        aria-label="Find a person"
                        placeholder="Find a person"
                        value={search}
                        onChange={event => setSearch(event.currentTarget.value)}
                    />

                    <div className={cl("sort")}>
                        <span>Sort by</span>
                        <Select
                            options={PEOPLE_SORTS}
                            select={changeSort}
                            isSelected={value => value === sort}
                            serialize={String}
                        />
                    </div>

                    <div className={cl("people")}>
                        {!!tracked.length && <h3 className={cl("people-heading")}>Tracking {tracked.length}</h3>}
                        {tracked.map(person => <PersonRow key={person.id} person={person} selected={person.id === activeId} onSelect={() => setSelectedId(person.id)} />)}

                        {!!previous.length && <h3 className={cl("people-heading")}>No longer tracking</h3>}
                        {previous.map(person => <PersonRow key={person.id} person={person} selected={person.id === activeId} onSelect={() => setSelectedId(person.id)} />)}
                    </div>

                    <div className={cl("sidebar-foot")}>
                        {history.hasOlder() && <button className={cl("link")} onClick={() => void history.loadOlder()}>Load older than 90 days</button>}
                        <button className={cl("link")} onClick={() => downloadFile("activity.json", JSON.stringify(logs, null, 2), "application/json")}>Export everything</button>
                        <button className={cl("link")} data-danger="true" onClick={confirmClear}>Delete everything</button>
                    </div>
                </aside>

                {activeId
                    ? <Person key={activeId} userId={activeId} logs={byUser.get(activeId) ?? []} onClose={modalProps.onClose} onSelect={setSelectedId} tick={tick} />
                    : (
                        <main className={cl("main")}>
                            <div className={cl("welcome")}>
                                <RadarIcon width={40} height={40} />
                                <h2>Nobody is being tracked</h2>
                                <p>Right-click a person and choose Start Tracking User. Their activity appears here from that moment.</p>
                            </div>
                        </main>
                    )}
            </div>
        </Modal>
    );
}
