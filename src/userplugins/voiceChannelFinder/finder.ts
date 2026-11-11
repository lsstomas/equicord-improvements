/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { getUniqueUsername } from "@utils/discord";
import { proxyLazy } from "@utils/lazy";
import type { Channel } from "@vencord/discord-types";
import { findByCodeLazy } from "@webpack";
import { GuildChannelStore, GuildMemberStore, GuildStore, PermissionsBits, PermissionStore, SelectedChannelStore, useMemo, UserGuildSettingsStore, UserStore, useStateFromStores, VoiceStateStore, zustandCreate } from "@webpack/common";

export const occupationOptions = [
    { value: "any", label: "Any" },
    { value: "empty", label: "Empty" },
    { value: "occupied", label: "Occupied" },
    { value: "full", label: "Full" },
    { value: "range", label: "Count" },
] as const;

export interface Filters {
    person: string;
    occupation: typeof occupationOptions[number]["value"];
    minimum: string;
    maximum: string;
    joinable: boolean;
    onlyResults: boolean;
}

interface FinderState {
    guildId: string | null;
    filters: Filters;
}

export const defaultFilters: Filters = {
    person: "",
    occupation: "any",
    minimum: "",
    maximum: "",
    joinable: false,
    onlyResults: false,
};

type FinderStore = {
    <T>(selector: (state: FinderState) => T): T;
    setState(state: FinderState): void;
};

export const finderStore: FinderStore = proxyLazy(() => zustandCreate((): FinderState => ({
    guildId: null,
    filters: defaultFilters,
})));

export function useFilters(guildId: string) {
    return finderStore(state => state.guildId === guildId ? state.filters : defaultFilters);
}

const normalize = (value: string) => value.trim().toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");
const personQuery = (value: string) => normalize(value).replace(/^@/, "").trim();
const exactId = /^\d{17,20}$/;
export const filterActive = (filters: Filters) => !!personQuery(filters.person) || filters.occupation !== "any" || filters.joinable;
const isAtVoiceCapacity: (channel: Channel, voiceStates: typeof VoiceStateStore, guilds: typeof GuildStore) => boolean = findByCodeLazy(".maxStageVideoChannelUsers", ".countVoiceStatesForChannel(", ".MOVE_MEMBERS");

function isVisibleVoiceChannel(channel: Channel) {
    return channel.isGuildVocal()
        && PermissionStore.can(PermissionsBits.VIEW_CHANNEL, channel)
        && (!UserGuildSettingsStore.isOptInEnabled(channel.guild_id)
            || UserGuildSettingsStore.isChannelOrParentOptedIn(channel.guild_id, channel.id)
            || UserGuildSettingsStore.isFavorite(channel.guild_id, channel.id));
}

export function getMatchingChannels(guildId: string, filters: Filters) {
    const matches: Channel[] = [];
    const query = personQuery(filters.person);
    const searchById = exactId.test(query);
    const min = filters.minimum === "" ? 0 : Number(filters.minimum);
    const max = filters.maximum === "" ? (filters.minimum === "" ? Infinity : min) : Number(filters.maximum);
    const connected = filters.joinable ? SelectedChannelStore.getVoiceChannelId() : null;
    for (const { channel } of GuildChannelStore.getChannels(guildId).VOCAL) {
        if (!isVisibleVoiceChannel(channel)) continue;
        const { occupation } = filters;
        const atCapacity = (filters.joinable || occupation === "full") && isAtVoiceCapacity(channel, VoiceStateStore, GuildStore);
        const ids = Object.keys(VoiceStateStore.getVoiceStatesForChannel(channel.id));
        const count = ids.length;
        const limitReached = channel.userLimit > 0 && count >= channel.userLimit;
        if (filters.joinable && (!PermissionStore.can(PermissionsBits.CONNECT, channel)
            || connected !== channel.id && (atCapacity || limitReached && !PermissionStore.can(PermissionsBits.MOVE_MEMBERS, channel)))) continue;
        if (occupation === "empty" && count !== 0
            || occupation === "occupied" && count === 0
            || occupation === "full" && !(atCapacity || limitReached)
            || occupation === "range" && (count < min || count > max)) continue;

        if (query && !(searchById ? ids.includes(query) : ids.some(id => {
            const user = UserStore.getUser(id);
            const nick = GuildMemberStore.getNick(guildId, id);
            return [nick, user?.globalName, user?.username, user && getUniqueUsername(user)].some(name => name && normalize(name).includes(query));
        }))) continue;
        matches.push(channel);
    }
    return matches;
}

function voiceStores() {
    return [GuildChannelStore, GuildStore, PermissionStore, UserGuildSettingsStore, SelectedChannelStore, VoiceStateStore, UserStore, GuildMemberStore];
}

export interface SidebarFilter {
    matches: Set<string>;
    onlyResults: boolean;
    emphasizeMatch: boolean;
}

export function useSidebarState(guildId: string) {
    const filters = useFilters(guildId);
    return useStateFromStores(voiceStores(), (): SidebarFilter | null => {
        if (!filterActive(filters)) return null;
        const matches = new Set(getMatchingChannels(guildId, filters).map(channel => channel.id));
        return {
            matches,
            onlyResults: filters.onlyResults,
            emphasizeMatch: matches.size === 1 && !!personQuery(filters.person),
        };
    }, [guildId, filters], (a, b) => a === b || a != null && b != null
        && a.onlyResults === b.onlyResults && a.emphasizeMatch === b.emphasizeMatch
        && a.matches.size === b.matches.size && [...a.matches].every(id => b.matches.has(id)));
}

export function getRowStatus(channel: Channel, filter: SidebarFilter | null) {
    if (!filter || !channel.isGuildVocal()) return;
    if (filter.matches.has(channel.id)) return filter.emphasizeMatch ? "person-match" : "match";
    return filter.onlyResults ? "hidden" : "dimmed";
}

export function useVoiceSummaryStates<T>(voiceStates: Record<string, T>, filter: SidebarFilter | null) {
    return useMemo(() => {
        if (!filter?.onlyResults) return voiceStates;
        const visible: Record<string, T> = {};
        for (const id of filter.matches) {
            if (id in voiceStates) visible[id] = voiceStates[id];
        }
        return visible;
    }, [voiceStates, filter]);
}
