/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/*
 * Guarda o histórico em blocos pequenos e imutáveis, e só lê quando a janela de logs pede.
 *
 * Nada é lido ao abrir o Discord, porque essa leitura era o que congelava a abertura. Cada bloco
 * guarda colunas em typed arrays, que o IndexedDB copia como memória crua, e nomes uma vez só.
 * Gravar acrescenta um bloco e nunca reescreve o dia, então o custo não cresce com o histórico.
 */

import { filterEntries, getChannelLabel, getDayKey, LogFilter, reviveEntry } from "./history";
import { LogEventType, VoiceChannelLogEntry } from "./types";

export const CHUNK_SIZE = 500;
const MAX_UNSAVED = 5000;
const MAX_CACHED_CHUNKS = 400;
const READ_BATCH = 6;
const DAY_MS = 86_400_000;

const CHUNK_PREFIX = "v2:";
const indexKey = (account: string) => `v2-index:${account}`;
const metaKey = (account: string) => `v2-meta:${account}`;
const LEGACY_DAY = /^\d{4}-\d{2}-\d{2}$/;

// Só acrescente no fim: a posição é o que fica salvo.
const EVENT_TYPES: LogEventType[] = ["join", "leave", "move", "present", "soundboard", "self_mute", "self_deafen", "server_mute", "server_deafen", "self_video", "self_stream", "activity", "activity_stop"];
const VOICE_FLAGS = ["muted", "deafened", "camera on", "screensharing"];
const KNOWN_FLAGS = (1 << VOICE_FLAGS.length) - 1;
const HAS_FLAGS = 16;
const ENABLED = 32;
const HAS_ENABLED = 64;
const EXTRA_FIELDS = ["oldChannelId", "oldChannelName", "newChannelId", "newChannelName", "soundId", "emoji", "activityName", "applicationId"] as const;

type Extra = Partial<Pick<VoiceChannelLogEntry, typeof EXTRA_FIELDS[number]>>;
type UserRow = [id: string, username?: string, displayName?: string, avatar?: string];
type ChannelRow = [id: string, name?: string, guildId?: string, guildName?: string];

export interface LogChunk {
    time: Float64Array;
    kind: Uint8Array;
    state: Uint8Array;
    user: Uint16Array;
    channel: Uint16Array;
    /** Posição em `calls` mais um; 0 significa sem chamada. */
    call: Uint16Array;
    users: UserRow[];
    channels: ChannelRow[];
    calls: number[];
    extras: Record<number, Extra>;
}

export interface LogStorage {
    keys(): Promise<string[]>;
    getMany(keys: string[]): Promise<unknown[]>;
    set(key: string, value: unknown): Promise<void>;
    del(key: string): Promise<void>;
}

export interface LogStoreOptions {
    shouldPersist(): boolean;
    retentionDays(): number;
    onError(message: string, error?: unknown): void;
    /** Acrescenta linhas ao arquivo do dia, para o histórico sobreviver ao armazenamento. */
    appendDay?(account: string, day: string, content: string): Promise<void>;
    /** Substitui o arquivo do dia. Só a migração usa. */
    writeDay?(account: string, day: string, content: string): Promise<void>;
}

interface LogIndex {
    channels: Record<string, Pick<VoiceChannelLogEntry, "channelName" | "guildId" | "guildName">>;
}

function internRows<Row extends [string, ...unknown[]]>(rows: Row[], positions: Map<string, number>, id: string, build: () => Row): number {
    const known = positions.get(id);
    if (known !== undefined) return known;
    positions.set(id, rows.length);
    rows.push(build());
    return rows.length - 1;
}

function encodeState({ flags, enabled }: VoiceChannelLogEntry): number {
    let state = flags ? HAS_FLAGS : 0;
    for (const flag of flags ?? []) {
        const position = VOICE_FLAGS.indexOf(flag);
        if (position >= 0) state |= 1 << position;
    }
    if (enabled !== undefined) state |= HAS_ENABLED | (enabled ? ENABLED : 0);
    return state;
}

export function encodeChunk(entries: VoiceChannelLogEntry[]): LogChunk {
    const { length } = entries;
    const chunk: LogChunk = {
        time: new Float64Array(length),
        kind: new Uint8Array(length),
        state: new Uint8Array(length),
        user: new Uint16Array(length),
        channel: new Uint16Array(length),
        call: new Uint16Array(length),
        users: [],
        channels: [],
        calls: [],
        extras: {}
    };
    const users = new Map<string, number>();
    const channels = new Map<string, number>();
    const calls = new Map<number, number>();

    entries.forEach((entry, index) => {
        chunk.time[index] = entry.timestamp.getTime();
        chunk.kind[index] = EVENT_TYPES.indexOf(entry.type);
        chunk.state[index] = encodeState(entry);
        chunk.user[index] = internRows(chunk.users, users, entry.userId, () => [entry.userId, entry.username, entry.displayName, entry.avatar]);
        chunk.channel[index] = internRows(chunk.channels, channels, entry.channelId, () => [entry.channelId, entry.channelName, entry.guildId, entry.guildName]);

        if (entry.callStartedAt) {
            let call = calls.get(entry.callStartedAt);
            if (call === undefined) {
                call = chunk.calls.push(entry.callStartedAt);
                calls.set(entry.callStartedAt, call);
            }
            chunk.call[index] = call;
        }

        let extra: Extra | undefined;
        for (const field of EXTRA_FIELDS) {
            if (entry[field] === undefined) continue;
            extra ??= {};
            (extra as Record<string, unknown>)[field] = entry[field];
        }
        if (extra) chunk.extras[index] = extra;
    });

    return chunk;
}

function defined<T extends object>(value: T): T {
    for (const key of Object.keys(value)) {
        if (value[key as keyof T] == null) delete value[key as keyof T];
    }
    return value;
}

export function decodeChunk(chunk: LogChunk, key: string): VoiceChannelLogEntry[] {
    const entries: VoiceChannelLogEntry[] = new Array(chunk.time.length);

    for (let index = 0; index < chunk.time.length; index++) {
        const [userId, username, displayName, avatar] = chunk.users[chunk.user[index]];
        const [channelId, channelName, guildId, guildName] = chunk.channels[chunk.channel[index]];
        const state = chunk.state[index];
        const call = chunk.call[index];

        entries[index] = defined({
            id: `${key}#${index}`,
            type: EVENT_TYPES[chunk.kind[index]],
            userId,
            channelId,
            timestamp: new Date(chunk.time[index]),
            callStartedAt: call ? chunk.calls[call - 1] : undefined,
            guildId,
            guildName,
            channelName,
            username,
            displayName,
            avatar,
            flags: state & HAS_FLAGS ? VOICE_FLAGS.filter((_, position) => state & KNOWN_FLAGS & (1 << position)) : undefined,
            enabled: state & HAS_ENABLED ? (state & ENABLED) !== 0 : undefined,
            ...chunk.extras[index]
        });
    }

    return entries;
}

function dayOfChunk(key: string): string {
    return key.split(":")[2];
}

function chunkKey(account: string, day: string, time: number, sequence: number): string {
    // Tamanho fixo, para a ordem das chaves ser a ordem do tempo.
    return `${CHUNK_PREFIX}${account}:${day}:${time.toString(36).padStart(9, "0")}-${sequence.toString(36).padStart(4, "0")}`;
}

function splitByDay(entries: VoiceChannelLogEntry[]): Map<string, VoiceChannelLogEntry[]> {
    const days = new Map<string, VoiceChannelLogEntry[]>();
    for (const entry of entries) {
        const day = getDayKey(entry.timestamp);
        const list = days.get(day);
        if (list) list.push(entry);
        else days.set(day, [entry]);
    }
    return days;
}

const toLines = (entries: VoiceChannelLogEntry[]) => `${entries.map(entry => JSON.stringify(entry)).join("\n")}\n`;

export function createLogStore(storage: LogStorage, options: LogStoreOptions) {
    let accountId: string | null = null;
    let buffer: VoiceChannelLogEntry[] = [];
    let writing: VoiceChannelLogEntry[] = [];
    let writes: Promise<void> = Promise.resolve();
    let version = 0;
    let sequence = 0;
    let listeners: (() => void)[] = [];
    let index: { account: string; value: LogIndex; } | null = null;
    let migration: { account: string; done: Promise<void>; } | null = null;
    const cache = new Map<string, VoiceChannelLogEntry[]>();

    function notify() {
        version++;
        listeners.forEach(listener => listener());
    }

    async function readIndex(account: string): Promise<LogIndex> {
        if (index?.account === account) return index.value;
        const [saved] = await storage.getMany([indexKey(account)]) as [LogIndex | undefined];
        index = { account, value: saved ?? { channels: {} } };
        return index.value;
    }

    async function remember(account: string, entries: VoiceChannelLogEntry[]) {
        const { channels } = await readIndex(account);
        let changed = false;

        for (const { channelId, channelName, guildId, guildName } of entries) {
            const known = channels[channelId];
            if (known && known.channelName === channelName && known.guildName === guildName) continue;
            channels[channelId] = { channelName, guildId, guildName };
            changed = true;
        }

        if (changed) await storage.set(indexKey(account), { channels });
    }

    async function writeBatch(account: string, batch: VoiceChannelLogEntry[]) {
        writing = batch;

        try {
            for (const [day, entries] of splitByDay(batch)) {
                for (let start = 0; start < entries.length; start += CHUNK_SIZE) {
                    const slice = entries.slice(start, start + CHUNK_SIZE);
                    await storage.set(chunkKey(account, day, slice[0].timestamp.getTime(), sequence++), encodeChunk(slice));
                    const saved = new Set(slice);
                    writing = writing.filter(entry => !saved.has(entry));
                }
                await remember(account, entries);
                await options.appendDay?.(account, day, toLines(entries));
            }
        } catch (error) {
            buffer = [...writing, ...buffer];
            options.onError("Failed to save logs", error);
        } finally {
            writing = [];
        }
    }

    function flush(): Promise<void> {
        if (!accountId || !buffer.length || !options.shouldPersist()) return writes;

        const account = accountId;
        const batch = buffer;
        buffer = [];
        writes = writes.then(() => writeBatch(account, batch));
        return writes;
    }

    async function migrateLegacy(account: string) {
        const [meta] = await storage.getMany([metaKey(account)]) as [{ migrated?: boolean; } | undefined];
        if (meta?.migrated) return;

        const prefix = `${account}:`;
        const legacy = (await storage.keys()).filter(key => key.startsWith(prefix) && LEGACY_DAY.test(key.slice(prefix.length)));
        if (!legacy.length) return;

        const seen = new Set<string>();
        const unique: VoiceChannelLogEntry[] = [];
        let before = 0;

        // Um dia de cada vez: juntar tudo antes de filtrar levaria as cópias inteiras para a memória.
        for (const key of legacy) {
            const [bucket] = await storage.getMany([key]);
            if (!Array.isArray(bucket)) continue;

            for (const raw of bucket) {
                before++;
                const entry = reviveEntry(raw);
                if (!entry || seen.has(entry.id)) continue;
                seen.add(entry.id);
                unique.push(entry);
            }
        }

        unique.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

        for (const [day, entries] of splitByDay(unique)) {
            for (let start = 0; start < entries.length; start += CHUNK_SIZE) {
                const slice = entries.slice(start, start + CHUNK_SIZE);
                // A chave vem do conteúdo, então repetir uma migração interrompida reescreve o mesmo bloco.
                await storage.set(chunkKey(account, day, slice[0].timestamp.getTime(), start / CHUNK_SIZE), encodeChunk(slice));
            }
            await remember(account, entries);
            await options.writeDay?.(account, day, toLines(entries));
        }

        // Os registros antigos ficam como cópia de segurança: ninguém mais os lê, e Clear all os apaga.
        await storage.set(metaKey(account), { migrated: true, before, after: unique.length });
    }

    function ready(account: string): Promise<void> {
        if (migration?.account === account) return migration.done;

        const current = { account, done: migrateLegacy(account).catch(error => {
            if (migration === current) migration = null;
            throw error;
        }) };
        migration = current;
        return current.done;
    }

    async function chunkKeys(account: string): Promise<string[]> {
        const prefix = `${CHUNK_PREFIX}${account}:`;
        return (await storage.keys()).filter(key => key.startsWith(prefix)).sort();
    }

    async function readChunks(keys: string[]): Promise<VoiceChannelLogEntry[][]> {
        const missing = keys.filter(key => !cache.has(key));

        if (missing.length) {
            const chunks = await storage.getMany(missing) as (LogChunk | undefined)[];
            chunks.forEach((chunk, position) => {
                if (cache.size >= MAX_CACHED_CHUNKS) cache.delete(cache.keys().next().value!);
                if (chunk) cache.set(missing[position], decodeChunk(chunk, missing[position]));
            });
        }

        return keys.map(key => cache.get(key) ?? []);
    }

    const unsaved = () => [...writing, ...buffer];

    /** Lê dos blocos mais novos para os mais antigos e para assim que tiver o suficiente. */
    async function read(filter: LogFilter, limit: number) {
        const account = accountId;
        const keys = account ? await ready(account).then(() => chunkKeys(account)) : [];
        const found = filterEntries(unsaved(), filter);

        for (let end = keys.length; end > 0 && found.length <= limit; end -= READ_BATCH) {
            const chunks = await readChunks(keys.slice(Math.max(0, end - READ_BATCH), end));
            for (let position = chunks.length - 1; position >= 0; position--) found.push(...filterEntries(chunks[position], filter));
        }

        return found;
    }

    return {
        /** Só guarda a conta. É síncrono de propósito: não existe abertura pela metade para correr. */
        open(id: string) {
            if (id === accountId) return;

            void flush();
            accountId = id;
            cache.clear();
            notify();
        },

        add(entry: VoiceChannelLogEntry) {
            buffer.push(entry);

            if (!options.shouldPersist() && buffer.length > MAX_UNSAVED) buffer = buffer.slice(-MAX_UNSAVED);
            else if (buffer.length >= CHUNK_SIZE) void flush();

            notify();
        },

        flush,

        getVersion: () => version,

        subscribe(listener: () => void) {
            listeners = [...listeners, listener];
            return () => {
                listeners = listeners.filter(current => current !== listener);
            };
        },

        async page(filter: LogFilter, limit: number) {
            const found = await read(filter, limit);
            return { entries: found.slice(0, limit), hasMore: found.length > limit };
        },

        all: (filter: LogFilter) => read(filter, Infinity),

        async channels() {
            const account = accountId;
            const known: LogIndex["channels"] = {};

            if (account) {
                await ready(account);
                Object.assign(known, (await readIndex(account)).channels);
            }
            for (const { channelId, channelName, guildId, guildName } of unsaved()) known[channelId] = { channelName, guildId, guildName };

            return Object.entries(known)
                .map(([value, channel]) => ({ value, label: getChannelLabel(channel) }))
                .sort((a, b) => a.label.localeCompare(b.label));
        },

        /** Solta da memória o que a janela de logs leu. */
        release() {
            cache.clear();
        },

        /** Apaga um canal, ou tudo quando nenhum é informado. */
        async clear(channelId?: string) {
            const account = accountId;
            buffer = channelId ? buffer.filter(entry => entry.channelId !== channelId) : [];
            cache.clear();

            if (account) {
                await writes;
                await ready(account);
                const keys = await chunkKeys(account);

                if (!channelId) {
                    const prefix = `${account}:`;
                    const legacy = (await storage.keys()).filter(key => key.startsWith(prefix));
                    await Promise.all([...keys, ...legacy, indexKey(account)].map(key => storage.del(key)));
                    index = null;
                } else {
                    for (const key of keys) {
                        const [chunk] = await storage.getMany([key]) as [LogChunk | undefined];
                        if (!chunk?.channels.some(([id]) => id === channelId)) continue;

                        const kept = decodeChunk(chunk, key).filter(entry => entry.channelId !== channelId);
                        if (kept.length) await storage.set(key, encodeChunk(kept));
                        else await storage.del(key);
                    }

                    const { channels } = await readIndex(account);
                    delete channels[channelId];
                    await storage.set(indexKey(account), { channels });
                }
            }

            notify();
        },

        /** Apaga dias vencidos. Sem prazo definido, não toca no armazenamento. */
        async prune() {
            const retention = options.retentionDays();
            if (!accountId || retention <= 0) return;

            const cutoff = getDayKey(new Date(Date.now() - retention * DAY_MS));
            const expired = (await chunkKeys(accountId)).filter(key => dayOfChunk(key) < cutoff);
            await Promise.all(expired.map(key => storage.del(key)));
        }
    };
}
