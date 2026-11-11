/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

import ts from "typescript";

function pluginPatches(relative) {
    const filename = new URL(`../src/${relative}`, import.meta.url);
    const source = ts.createSourceFile(String(filename), readFileSync(filename, "utf8"), ts.ScriptTarget.Latest, true);
    const plugin = source.statements.find(ts.isExportAssignment).expression.arguments[0];
    const patches = plugin.properties.find(property => property.name?.getText(source) === "patches").initializer;
    return vm.runInNewContext(patches.getText(source));
}

function canonical(regex) {
    return new RegExp(regex.source.replaceAll(String.raw`\i`, String.raw`(?:[A-Za-z_$][\w$]*)`), regex.flags);
}

const audioPatches = pluginPatches("equicordplugins/_api/audioPlayer.ts");
const factoryPatch = audioPatches.find(patch => patch.find === "SoundUtils").replacement;
const constructorPatch = audioPatches[0].replacement.find(patch => patch.match.source.startsWith("constructor"));

for (const tracking of ["", ",a"]) {
    const original = `function c(e,t,n,r,a){return new Player(e,t,n,r${tracking})}const exported=c;`;
    const patched = original.replace(canonical(factoryPatch.match), factoryPatch.replace);
    assert.notEqual(patched, original);
    const NativePlayer = class {
        constructor(options, audio, unused, volume, output, track = false) {
            Object.assign(this, { options, audio, volume, output, track });
        }
    };
    const create = new Function("Player", `${patched};return c;`)(NativePlayer);
    const player = create("mute", "mute", 0.5, "default", true);
    assert.equal(player.options, undefined);
    assert.equal(player.audio, "mute");
    assert.equal(player.volume, 0.5, "The output name must never become the numeric volume");
    assert.equal(player.output, "default");
    assert.equal(player.track, tracking.length > 0);
}

{
    const original = "class Player{constructor(e,t,n,i,r=!1){this.name=e,this._volume=n,this.outputChannel=i,this.trackNotificationFailure=r}}";
    const patched = original.replace(canonical(constructorPatch.match), constructorPatch.replace.replaceAll("$self", "api"));
    assert.notEqual(patched, original);
    const api = { buildPlayer(player, options, audio, unused, volume, output) { Object.assign(player, { audio, options, volume, output }); } };
    const Player = new Function("api", `${patched};return Player;`)(api);
    const player = new Player(undefined, "mute", "mute", 0.5, "voice", true);
    assert.equal(player.name, "mute");
    assert.equal(player.volume, 0.5);
    assert.equal(player.trackNotificationFailure, true, "Native constructor fields survive API initialization");
}

const finderPatches = pluginPatches("userplugins/voiceChannelFinder/index.tsx");
const marker = finderPatches.find(patch => patch.find.startsWith("VoiceChannel.renderPopout")).replacement;
const dragify = pluginPatches("equicordplugins/dragify/index.tsx").find(patch => patch.find.includes("voice-conversations"));
const source = '(0,r.jsxs)("li",{ref:this.ref,className:eJ()(this.getModeClass(),{[ep.r9]:this.isDisabled(),[ep.fy]:I}),"data-dnd-name":(0,t8.m1)(e,lf.default,se.A),children:[]})';

for (const order of [["dragify", "finder"], ["finder", "dragify"]]) {
    let code = source;
    for (const name of order) {
        const patch = name === "finder" ? marker : dragify.replacement[1];
        const updated = code.replace(canonical(patch.match), patch.replace.replaceAll("$self", name));
        assert.notEqual(updated, code, `${name} works after ${order[0]}`);
        code = updated;
    }
    assert.match(code, /"data-vc-voice-finder-row":this\.props\.vcVoiceFinderRow/);
    assert.match(code, /dragify\.onChannelDragStart/);
    new vm.Script(`function render(){return ${code};}`);
}

console.log("Discord compatibility: native sound arguments and voice filtering with Dragify passed.");
