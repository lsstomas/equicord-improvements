/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Compares the log store with the old day store on synthetic history. Usage: node scripts/benchVoiceChannelLog.mjs [entries]
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { serialize } from "node:v8";

import { build } from "esbuild";

const load = async path => {
    const result = await build({
        entryPoints: [fileURLToPath(new URL(`../src/equicordplugins/voiceChannelLog/${path}`, import.meta.url))],
        bundle: true, write: false, format: "cjs", platform: "node"
    });
    const module = { exports: {} };
    new Function("module", "exports", "require", result.outputFiles[0].text)(module, module.exports, createRequire(import.meta.url));
    return module.exports;
};

const { createLogStore, encodeChunk, CHUNK_SIZE } = await load("logStore.ts");
const { createDayStore } = await load("dayStore.ts");
const { reviveEntry } = await load("history.ts");

const TOTAL = Number(process.argv[2]) || 1_000_000;
const DAYS = 90;
const DAY_MS = 86_400_000;
const now = Date.now();
const TYPES = ["self_mute", "self_deafen", "join", "leave", "present", "self_video", "self_stream"];
const FILTER = { channelId: null, group: "all", query: "" };

const entryFor = index => ({
    id: `e${index}`,
    type: TYPES[index % TYPES.length],
    userId: `1${String(index % 40).padStart(17, "0")}`,
    channelId: `2${String(index % 12).padStart(17, "0")}`,
    timestamp: new Date(now - (DAYS * DAY_MS) + Math.floor(index * (DAYS * DAY_MS) / TOTAL)),
    callStartedAt: now - (index % 50) * 3_600_000,
    guildId: "300000000000000000",
    guildName: "Friends of the server",
    channelName: `voice-${index % 12}`,
    username: `user_${index % 40}`,
    displayName: `Person ${index % 40}`,
    avatar: "a".repeat(32),
    enabled: index % 2 === 0
});

function memoryStorage() {
    const data = new Map();
    return {
        data,
        async keys() { return [...data.keys()]; },
        async getMany(keys) { return keys.map(key => structuredClone(data.get(key))); },
        async set(key, value) { data.set(key, structuredClone(value)); },
        async del(key) { data.delete(key); }
    };
}

const options = { shouldPersist: () => true, retentionDays: () => 0, onError(message, error) { throw error ?? new Error(message); } };
const ms = (start, end = performance.now()) => end - start;
const percentile = (values, share) => [...values].sort((a, b) => a - b)[Math.floor(values.length * share)];

const storage = memoryStorage();
const store = createLogStore(storage, options);
store.open("me");

const addTimes = [];
const flushTimes = [];
let addTotal = 0;
for (let index = 0; index < TOTAL; index++) {
    const entry = entryFor(index);
    const start = performance.now();
    store.add(entry);
    const elapsed = performance.now() - start;
    addTotal += elapsed;
    if (index % 997 === 0) addTimes.push(elapsed);
    if (index % CHUNK_SIZE === CHUNK_SIZE - 1) {
        const flushing = performance.now();
        await store.flush();
        flushTimes.push(ms(flushing));
    }
}
await store.flush();

const chunks = [...storage.data].filter(([key]) => key.startsWith("v2:"));
const sampleChunk = chunks[Math.floor(chunks.length / 2)][1];
const bytesPerEntry = serialize(sampleChunk).length / sampleChunk.time.length;

const reader = createLogStore(storage, options);
const opening = performance.now();
await Promise.all([reader.open("me"), reader.open("me")]);
const openMs = ms(opening);

const firstPage = performance.now();
await reader.page(FILTER, 200);
const pageMs = ms(firstPage);
const secondPage = performance.now();
await reader.page(FILTER, 400);
const nextPageMs = ms(secondPage);
reader.release();

const filtered = performance.now();
await reader.page({ ...FILTER, group: "stream" }, 200);
const filterMs = ms(filtered);
reader.release();

const searching = performance.now();
await reader.page({ ...FILTER, query: "person 7" }, 200);
const searchMs = ms(searching);
reader.release();

const scanning = performance.now();
await reader.page({ ...FILTER, query: "nobody by this name" }, 200);
const scanMs = ms(scanning);
reader.release();

console.log(`NOVO   ${TOTAL} entradas em ${DAYS} dias, ${chunks.length} blocos`);
console.log(`  abrir                ${openMs.toFixed(3)} ms`);
console.log(`  add p50/p99          ${(percentile(addTimes, 0.5) * 1000).toFixed(2)} / ${(percentile(addTimes, 0.99) * 1000).toFixed(2)} µs  media ${(addTotal / TOTAL * 1000).toFixed(2)} µs`);
console.log(`  salvar bloco p50/p99 ${percentile(flushTimes, 0.5).toFixed(2)} / ${percentile(flushTimes, 0.99).toFixed(2)} ms`);
console.log(`  bytes por entrada    ${bytesPerEntry.toFixed(1)}`);
console.log(`  total estimado       ${(bytesPerEntry * TOTAL / 1048576).toFixed(1)} MB`);
console.log(`  pagina 200 / 400     ${pageMs.toFixed(2)} / ${nextPageMs.toFixed(2)} ms`);
console.log(`  filtro raro          ${filterMs.toFixed(2)} ms`);
console.log(`  busca com resultado  ${searchMs.toFixed(2)} ms`);
console.log(`  busca sem resultado  ${scanMs.toFixed(0)} ms (varre tudo)`);

// O mesmo volume no formato antigo. Só o que importa para a comparação.
const legacyEntries = Array.from({ length: TOTAL }, (_, index) => entryFor(index));
const legacyBytes = serialize(legacyEntries.slice(0, 2000).map(entry => ({ ...entry }))).length / 2000;
const legacyStorage = memoryStorage();
const seed = createDayStore(legacyStorage, { ...options, getTime: entry => entry.timestamp, revive: reviveEntry });
const buckets = new Map();
for (const entry of legacyEntries) {
    const key = `me:${entry.timestamp.toISOString().slice(0, 10)}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(entry);
}
for (const [key, bucket] of buckets) legacyStorage.data.set(key, bucket);

const legacy = createDayStore(legacyStorage, { ...options, getTime: entry => entry.timestamp, revive: reviveEntry });
const loading = performance.now();
await legacy.open("me");
const legacyOpen = ms(loading);

const adding = [];
for (let index = 0; index < 20; index++) {
    const start = performance.now();
    legacy.add({ ...legacyEntries[0], id: `new${index}`, timestamp: new Date() });
    adding.push(ms(start));
}
const saving = performance.now();
await legacy.flush();
const legacySave = ms(saving);

console.log("ANTIGO mesmo volume");
console.log(`  abrir                ${legacyOpen.toFixed(0)} ms`);
console.log(`  add p50              ${percentile(adding, 0.5).toFixed(2)} ms`);
console.log(`  salvar               ${legacySave.toFixed(1)} ms`);
console.log(`  bytes por entrada    ${legacyBytes.toFixed(1)}`);
void seed;
void encodeChunk;
