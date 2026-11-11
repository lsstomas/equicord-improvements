/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

import ts from "typescript";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const modules = new Map();
const sent = [];
const timers = new Map();
let selected = "voice";
let muted = false;
let deafened = false;
let video = false;
let realStream = null;
let failSend = false;
let finishMute;
let muteAction = () => { muted = true; };
let timerId = 0;
const socket = { send(op, data) { if (failSend) throw new Error("Send failed"); sent.push({ op, data }); } };
const common = {
    MediaEngineStore: { isSelfMute: () => muted, isSelfDeaf: () => deafened, isVideoEnabled: () => video },
    SelectedChannelStore: { getVoiceChannelId: () => selected },
    ChannelStore: { getChannel: id => id ? { id, guild_id: "guild" } : null },
    UserStore: { getCurrentUser: () => ({ id: "self" }) },
    ApplicationStreamingStore: { getCurrentUserActiveStream: () => realStream },
    PermissionStore: { can: () => true }, PermissionsBits: { STREAM: 1n },
    VoiceActions: { toggleSelfMute: () => muteAction() }, showToast() {},
    zustandCreate: init => {
        let state = init();
        return Object.assign(selector => selector(state), {
            getState: () => state,
            setState: next => { state = { ...state, ...next }; }
        });
    }
};
const mocks = {
    "@utils/types": { __esModule: true, default: p => p },
    "@utils/lazy": { proxyLazy: fn => { let cached; return new Proxy({}, { get: (_, key) => (cached ??= fn())[key] }); } },
    "@utils/Logger": { Logger: class { error() {} } },
    "@components/Paragraph": { Paragraph: "p" },
    "@webpack/common": common,
    "@webpack": { findByPropsLazy: () => ({ getSocket: () => socket }), findStoreLazy: () => ({ getRTCConnection() {} }) }
};

function load(filename) {
    for (const ext of ["", ".ts", ".tsx", "/index.tsx"]) {
        try {
            const path = filename + ext;
            const source = readFileSync(path, "utf8");
            if (modules.has(path)) return modules.get(path);
            const module = { exports: {} };
            modules.set(path, module.exports);
            const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022 } }).outputText;
            new Function("module", "exports", "require", "setTimeout", "clearTimeout", js)(module, module.exports, key => {
                if (key in mocks) return mocks[key];
                assert.ok(key.startsWith("."), `Unexpected import ${key}`);
                return load(resolve(dirname(path), key));
            }, callback => { timers.set(++timerId, callback); return timerId; }, id => timers.delete(id));
            return module.exports;
        } catch (error) {
            if (error.code !== "ENOENT" && error.code !== "EISDIR") throw error;
        }
    }
    throw new Error(`Module not found: ${filename}`);
}

const deafen = load(resolve(root, "src/userplugins/fakeDeafen/index.tsx")).default;
const media = load(resolve(root, "src/userplugins/fakeMedia/index.tsx")).default;
const { fakeStore } = load(resolve(root, "src/userplugins/fakeDeafen/state.ts"));
const state = mode => fakeStore.getState()[mode];
deafen.start();
media.start();
await deafen.toggleMute();
assert.equal(state("mute").active, true);
assert.equal(sent.at(-1).data.self_mute, true);
assert.equal(muted, false, "Fake Mute preserves the real microphone");
await deafen.toggleDeafen();
assert.equal(state("deafen").active, true);
assert.equal(muted, true, "Fake Deafen retains its microphone prerequisite");
assert.equal(deafened, false, "Fake Deafen never changes real deafen");
await deafen.toggleDeafen();
assert.equal(muted, true, "Turning fake deafen off preserves real mute");
assert.equal(state("deafen").active, false);

muted = false;
muteAction = () => new Promise(resolve => { finishMute = () => { muted = true; resolve(); }; });
const pending = deafen.toggleDeafen();
assert.equal(state("deafen").pending, true);
const before = sent.length;
await deafen.toggleMute();
assert.equal(sent.length, before, "Concurrent voice toggles are blocked");
deafen.stop();
deafen.start();
finishMute();
await pending;
assert.equal(state("deafen").active, false, "A stale completion cannot reactivate a stopped plugin");
assert.equal(state("deafen").pending, false);

selected = null;
await deafen.toggleMute();
assert.equal(state("mute").active, false);
assert.ok(state("mute").error);
selected = "voice";
video = true;
media.toggleCamera();
assert.equal(state("camera").active, false, "A real camera cannot be replaced with a fake camera");
assert.match(state("camera").error, /real camera/);
assert.equal(video, true);
video = false;
media.toggleCamera();
assert.equal(state("camera").active, true);
assert.equal(video, false, "Fake Camera does not start video capture");
assert.equal(sent.at(-1).data.self_video, true);
failSend = true;
media.toggleCamera();
assert.equal(state("camera").active, true, "A failed stop preserves the advertised state");
assert.ok(state("camera").error);
failSend = false;
media.toggleCamera();
assert.equal(state("camera").active, false);
assert.equal(state("camera").error, null);

media.toggleScreenShare();
assert.equal(state("screen").active, false, "Missing capture protection blocks stream startup");
assert.ok(state("screen").error);
media.markRtcGuardReady();
realStream = {};
media.toggleScreenShare();
assert.equal(state("screen").pending, false, "An existing real stream is left alone");
assert.match(state("screen").error, /current screen share/);
realStream = null;
media.toggleScreenShare();
assert.equal(state("screen").pending, true);
assert.equal(state("screen").active, false, "A requested stream is not a confirmed stream");
media.flux.STREAM_CREATE({ streamKey: "unrelated" });
assert.equal(state("screen").pending, true);
media.flux.STREAM_CREATE({ streamKey: "guild:guild:voice:self" });
assert.equal(state("screen").active, true);
assert.equal(state("screen").pending, false);
assert.equal(timers.size, 0);
media.toggleScreenShare();
assert.equal(state("screen").active, false);
media.toggleScreenShare();
media.toggleScreenShare();
assert.equal(state("screen").pending, false, "A pending request can be cancelled");
media.flux.STREAM_CREATE({ streamKey: "guild:guild:voice:self" });
assert.equal(state("screen").active, false, "A late confirmation cannot reactivate a cancelled stream");
media.toggleScreenShare();
[...timers.values()][0]();
assert.equal(state("screen").pending, false);
assert.equal(state("screen").active, false);
assert.match(state("screen").error, /did not confirm/);
media.toggleCamera();
await deafen.toggleMute();
media.flux.CONNECTION_CLOSED();
deafen.flux.CONNECTION_CLOSED();
for (const mode of ["mute", "deafen", "camera", "screen"]) assert.deepEqual(state(mode), { active: false, pending: false, error: null });
assert.equal(deafen.contextMenus, undefined);
assert.equal(media.contextMenus, undefined);

const filename = resolve(root, "src/userplugins/fakeControls/index.tsx");
const source = ts.createSourceFile(filename, readFileSync(filename, "utf8"), ts.ScriptTarget.Latest, true);
const definition = source.statements.find(ts.isExportAssignment).expression.arguments[0];
const patches = vm.runInNewContext(definition.properties.find(p => p.name?.getText(source) === "patches").initializer.getText(source));
const canonical = regex => new RegExp(regex.source.replaceAll(String.raw`\i`, String.raw`(?:[A-Za-z_$][\w$]*)`), regex.flags);
const fixtures = [
    'function panel(){return(0,v.jsxs)("div",{className:m8.uu,children:[(0,v.jsx)(TX,{channel:t,enableActivities:c,disabled:!r&&i}),(0,v.jsx)(Tq,{channel:t,canGoLive:n}),c&&(0,v.jsx)(Tz,{channel:t}),d?(0,v.jsx)(m4,{channel:t,focusProps:TW}):null]})}',
    'function camera(e){return(0,i.jsx)(I,{children:e=>{let{isActive:o,...c}=e;return(0,i.jsx)(g,{...c,...T,color:o?"green":T.color,className:s()(u),onPopoutClick:m,isTrayButton:!n})}})}'
];
for (const [index, patch] of patches.entries()) {
    let code = fixtures[index];
    for (const replacement of [].concat(patch.replacement)) {
        const updated = code.replace(canonical(replacement.match), replacement.replace.replaceAll("$self", "FakeControls"));
        assert.notEqual(updated, code, "Native insertion anchor applies");
        code = updated;
    }
    new vm.Script(code);
}
media.stop();
deafen.stop();
console.log("Fake controls: shared state, voice and media actions, pending confirmation, cancellation, failures, cleanup and native insertion passed.");

