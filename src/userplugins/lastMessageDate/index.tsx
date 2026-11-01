/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import ErrorBoundary from "@components/ErrorBoundary";
import { classNameFactory } from "@utils/css";
import definePlugin from "@utils/types";
import { ChannelStore, GuildStore, NavigationRouter, React, RestAPI, SelectedGuildStore } from "@webpack/common";

const cl = classNameFactory("vc-last-message-date-");

interface Lookup {
    state: "loading" | "found" | "none" | "indexing" | "failed";
    date?: Date;
    url?: string;
}

const NOT_INDEXED = 202;

/** Results for this session. Search is rate limited, so a repeat click must not call it again. */
const lookups = new Map<string, Lookup>();

async function searchLastMessage(scopeId: string, isGuild: boolean, userId: string): Promise<Lookup> {
    try {
        const response = await RestAPI.get({
            url: isGuild ? `/guilds/${scopeId}/messages/search` : `/channels/${scopeId}/messages/search`,
            query: { author_id: userId, sort_by: "timestamp", sort_order: "desc", offset: 0 }
        });

        if (response.status === NOT_INDEXED) return { state: "indexing" };

        const message = response.body.messages?.flat().find(found => found?.author?.id === userId);
        if (!message) return { state: "none" };

        return {
            state: "found",
            date: new Date(message.timestamp),
            url: `/channels/${isGuild ? scopeId : "@me"}/${message.channel_id}/${message.id}`
        };
    } catch {
        return { state: "failed" };
    }
}

const LastMessageSection = ErrorBoundary.wrap(({ userId }: { userId: string; }) => {
    const guildId = SelectedGuildStore.getGuildId();
    const scopeId = guildId ?? ChannelStore.getDMFromUserId(userId);
    const key = `${scopeId}:${userId}`;
    const [lookup, setLookup] = React.useState(lookups.get(key));

    if (!scopeId) return null;

    const scopeName = guildId ? GuildStore.getGuild(guildId)?.name ?? "this server" : "your DMs";

    async function check() {
        setLookup({ state: "loading" });

        const result = await searchLastMessage(scopeId!, !!guildId, userId);
        if (result.state === "found" || result.state === "none") lookups.set(key, result);
        setLookup(result);
    }

    const canCheck = !lookup || lookup.state === "indexing" || lookup.state === "failed";

    return (
        <div className={cl("section")}>
            <div className={cl("title")}>Last message in {scopeName}</div>
            {lookup?.state === "loading" && <div>Searching…</div>}
            {lookup?.state === "none" && <div>No messages found</div>}
            {lookup?.state === "indexing" && <div>Discord is still indexing this. Try again soon.</div>}
            {lookup?.state === "failed" && <div>Search failed. Try again later.</div>}
            {lookup?.state === "found" && (
                <button className={cl("button")} onClick={() => NavigationRouter.transitionTo(lookup.url!)}>
                    {lookup.date!.toLocaleString()}
                </button>
            )}
            {canCheck && <button className={cl("button")} onClick={() => void check()}>Check last message</button>}
        </div>
    );
}, { noop: true });

export default definePlugin({
    name: "LastMessageDate",
    description: "Adds a button to user profiles that finds their last message in the current server or your DMs. Searches only when clicked, because Discord rate limits search.",
    authors: [{ name: "Luis", id: 0n }],
    tags: ["Utility"],
    dependencies: ["ProfileSectionsAPI"],
    enabledByDefault: true,

    renderProfileSection: {
        render: LastMessageSection,
        priority: 0
    }
});
