/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export type PeopleSort = "activity" | "status" | "name" | "added";

export interface PersonInfo {
    id: string;
    name: string;
    status: string;
    inCall: boolean;
    lastAt: number;
    /** Position in the tracking list, oldest first. */
    addedIndex: number;
}

export const PEOPLE_SORTS: { value: PeopleSort; label: string; }[] = [
    { value: "activity", label: "Latest activity" },
    { value: "status", label: "Status" },
    { value: "name", label: "Name" },
    { value: "added", label: "Recently added" }
];

const STATUS_ORDER = ["online", "idle", "dnd", "offline"];

function statusRank({ status, inCall }: PersonInfo) {
    if (inCall) return -1;

    const rank = STATUS_ORDER.indexOf(status);
    return rank < 0 ? STATUS_ORDER.length : rank;
}

export function sortPeople(people: PersonInfo[], sort: PeopleSort): PersonInfo[] {
    const byActivity = (a: PersonInfo, b: PersonInfo) => b.lastAt - a.lastAt;
    const compare = {
        activity: byActivity,
        status: (a: PersonInfo, b: PersonInfo) => statusRank(a) - statusRank(b) || byActivity(a, b),
        name: (a: PersonInfo, b: PersonInfo) => a.name.localeCompare(b.name),
        added: (a: PersonInfo, b: PersonInfo) => b.addedIndex - a.addedIndex
    }[sort] ?? byActivity;

    return [...people].sort(compare);
}
