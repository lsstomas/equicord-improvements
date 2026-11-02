/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

const DAY_MS = 86_400_000;
const ARCHIVE_INTERVAL_MS = 7 * DAY_MS;

export interface DayStoreStorage {
    keys(): Promise<string[]>;
    getMany(keys: string[]): Promise<unknown[]>;
    set(key: string, value: unknown): Promise<void>;
    del(key: string): Promise<void>;
}

export interface DayStoreOptions<T> {
    getTime(entry: T): Date;
    /** Lets saved copies of the same record be dropped when they're loaded. */
    getId?(entry: T): unknown;
    /** Returns null for records that can't be used. */
    revive(raw: unknown): T | null;
    shouldPersist(): boolean;
    /** Days to keep saved logs. 0 keeps them forever. */
    retentionDays(): number;
    /** Days to keep in memory. Older days stay saved until loadOlder is called. 0 loads everything. */
    recentDays?(): number;
    onError(message: string, error: unknown): void;
}

interface ArchiveMeta {
    at: number;
    day: string;
}

export type ArchiveWriter = (day: string, content: string, accountId: string) => Promise<void>;

/** Local calendar day, so a saved bucket matches the date shown in the log. */
export function getDayKey(time: Date): string {
    const month = String(time.getMonth() + 1).padStart(2, "0");
    const day = String(time.getDate()).padStart(2, "0");
    return `${time.getFullYear()}-${month}-${day}`;
}

/**
 * Keeps logs in memory and saves one storage record per account and day,
 * so a new event only rewrites today's record instead of the whole history.
 */
export function createDayStore<T>(storage: DayStoreStorage, options: DayStoreOptions<T>) {
    let accountId: string | null = null;
    let loaded = false;
    let entries: T[] = [];
    let olderKeys: string[] = [];
    let listeners: (() => void)[] = [];
    let writes: Promise<void> = Promise.resolve();
    let opening: { id: string; done: Promise<void>; } | null = null;
    const dirtyDays = new Set<string>();

    const dayOf = (entry: T) => getDayKey(options.getTime(entry));
    const byTime = (a: T, b: T) => options.getTime(a).getTime() - options.getTime(b).getTime();

    function notify() {
        listeners.forEach(listener => listener());
    }

    async function writeDirtyDays(force: boolean) {
        // Writing before the load finished would replace saved days with partial ones.
        if (!loaded || !accountId || !dirtyDays.size) return;
        if (!force && !options.shouldPersist()) return;

        const days = [...dirtyDays];
        dirtyDays.clear();

        for (const day of days) {
            const bucket = entries.filter(entry => dayOf(entry) === day);
            const key = `${accountId}:${day}`;

            try {
                if (bucket.length) await storage.set(key, bucket);
                else await storage.del(key);
            } catch (error) {
                dirtyDays.add(day);
                options.onError(`Failed to save logs for ${day}`, error);
            }
        }
    }

    function flush(force = false): Promise<void> {
        writes = writes.then(() => writeDirtyDays(force));
        return writes;
    }

    async function getAccountKeys(id: string) {
        const prefix = `${id}:`;
        return (await storage.keys()).filter(key => typeof key === "string" && key.startsWith(prefix));
    }

    async function readBuckets(keys: string[]): Promise<T[]> {
        const buckets = await storage.getMany(keys);
        return withoutCopies(buckets
            .flatMap(bucket => Array.isArray(bucket) ? bucket : [])
            .map(options.revive)
            .filter(entry => entry != null));
    }

    function withoutCopies(records: T[]): T[] {
        const { getId } = options;
        if (!getId) return records;

        const seen = new Set<unknown>();
        return records.filter(record => {
            const id = getId(record);
            if (seen.has(id)) return false;
            seen.add(id);
            return true;
        });
    }

    function daysAgo(days: number) {
        return getDayKey(new Date(Date.now() - days * DAY_MS));
    }

    async function load(id: string) {
        const prefix = `${id}:`;
        const keys = await getAccountKeys(id);
        const dayOfKey = (key: string) => key.slice(prefix.length);

        const retention = options.retentionDays();
        const expiredBefore = retention > 0 ? daysAgo(retention) : null;
        const isExpired = (key: string) => expiredBefore != null && dayOfKey(key) < expiredBefore;

        const recent = options.recentDays?.() ?? 0;
        const recentFrom = recent > 0 ? daysAgo(recent) : null;
        const isOlder = (key: string) => recentFrom != null && dayOfKey(key) < recentFrom;

        const kept = keys.filter(key => !isExpired(key));

        return {
            stored: await readBuckets(kept.filter(key => !isOlder(key))),
            older: kept.filter(isOlder),
            expired: keys.filter(isExpired)
        };
    }

    async function loadAccount(id: string) {
        await flush();

        if (accountId) {
            entries = [];
            dirtyDays.clear();
        }

        accountId = id;
        loaded = false;
        olderKeys = [];
        notify();

        try {
            const { stored, older, expired } = await load(id);
            if (accountId !== id) return;

            entries = withoutCopies([...stored, ...entries]).sort(byTime);
            olderKeys = older;
            loaded = true;
            notify();

            await Promise.all(expired.map(key => storage.del(key)));
            await flush();
        } catch (error) {
            options.onError("Failed to load logs", error);
        }
    }

    return {
        /** Loads an account's saved logs. Events recorded before this call are kept. */
        open(id: string): Promise<void> {
            if (opening?.id === id) return opening.done;
            if (id === accountId) return Promise.resolve();

            // Claimed before anything waits, so a second call can't load the same logs again.
            const current = { id, done: loadAccount(id).finally(() => {
                if (opening === current) opening = null;
            }) };
            opening = current;
            return current.done;
        },

        add(entry: T) {
            entries = [...entries, entry];
            dirtyDays.add(dayOf(entry));
            notify();
        },

        hasOlder: () => olderKeys.length > 0,

        /** Brings the days left out by recentDays into memory. */
        async loadOlder() {
            const keys = olderKeys;
            olderKeys = [];

            try {
                entries = [...await readBuckets(keys), ...entries].sort(byTime);
                notify();
            } catch (error) {
                olderKeys = keys;
                options.onError("Failed to load older logs", error);
            }
        },

        /** Deletes the matching logs in memory, or every saved log when no filter is given. */
        async clear(isRemoved?: (entry: T) => boolean) {
            const removed = isRemoved ? entries.filter(isRemoved) : entries;
            const id = accountId;

            removed.forEach(entry => dirtyDays.add(dayOf(entry)));
            entries = isRemoved ? entries.filter(entry => !isRemoved(entry)) : [];
            notify();

            await flush(true);

            if (!isRemoved && id && loaded) {
                olderKeys = [];
                notify();
                await Promise.all((await getAccountKeys(id)).map(key => storage.del(key)));
            }
        },

        flush,

        getEntries: () => entries,

        subscribe(listener: () => void) {
            listeners = [...listeners, listener];
            return () => {
                listeners = listeners.filter(l => l !== listener);
            };
        },

        /** Writes each new day to the archive, at most once a week. Files outlive storage and Clear. */
        async archive(write: ArchiveWriter) {
            if (!loaded || !accountId) return;

            const id = accountId;
            const metaKey = `archive:${id}`;
            const prefix = `${id}:`;

            try {
                await flush();

                const [meta] = await storage.getMany([metaKey]) as [ArchiveMeta | undefined];
                if (meta && Date.now() - meta.at < ARCHIVE_INTERVAL_MS) return;

                // The last archived day was still being written to, so it goes again.
                const days = (await getAccountKeys(id))
                    .map(key => key.slice(prefix.length))
                    .filter(day => !meta || day >= meta.day)
                    .sort();

                for (const day of days) {
                    const [bucket] = await storage.getMany([`${prefix}${day}`]);
                    if (!Array.isArray(bucket)) continue;
                    await write(day, `${bucket.map(entry => JSON.stringify(entry)).join("\n")}\n`, id);
                }

                if (days.length) await storage.set(metaKey, { at: Date.now(), day: days[days.length - 1] } satisfies ArchiveMeta);
            } catch (error) {
                options.onError("Failed to archive logs", error);
            }
        }
    };
}
