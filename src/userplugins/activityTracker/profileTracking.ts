/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ProfileChange } from "./types";

export interface ProfileSnapshot {
    username?: string;
    globalName?: string | null;
    avatar?: string | null;
    banner?: string | null;
    bio?: string | null;
    pronouns?: string | null;
    avatarDecoration?: string | null;
    /** Nickname per server. */
    nicks?: Record<string, string | null>;
}

const FIELDS = ["username", "globalName", "avatar", "banner", "bio", "pronouns", "avatarDecoration"] as const;

/** undefined means Discord hasn't told us, so it must never count as the value being removed. */
export function mergeProfile(previous: ProfileSnapshot | undefined, next: ProfileSnapshot): { snapshot: ProfileSnapshot; changes: ProfileChange[]; } {
    const snapshot: ProfileSnapshot = { ...previous, nicks: { ...previous?.nicks } };
    const changes: ProfileChange[] = [];

    for (const field of FIELDS) {
        const value = next[field];
        if (value === undefined || (value || null) === (previous?.[field] || null)) continue;

        if (previous?.[field] !== undefined) changes.push({ field, before: previous[field] ?? undefined, after: value ?? undefined });
        (snapshot as Record<string, unknown>)[field] = value;
    }

    for (const [guildId, nick] of Object.entries(next.nicks ?? {})) {
        const before = previous?.nicks?.[guildId];
        if ((nick || null) === (before || null)) continue;

        if (before !== undefined) changes.push({ field: "nick", before: before ?? undefined, after: nick ?? undefined, guildId });
        snapshot.nicks![guildId] = nick;
    }

    return { snapshot, changes };
}

export function imageUrl(kind: "avatar" | "banner", userId: string, hash: string, size = 512): string {
    const folder = kind === "avatar" ? "avatars" : "banners";
    return `https://cdn.discordapp.com/${folder}/${userId}/${hash}.${hash.startsWith("a_") ? "gif" : "png"}?size=${size}`;
}
