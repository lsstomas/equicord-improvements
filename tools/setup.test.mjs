import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { backupInstallation, detectDiscords, inspectDiscord, mergeSetupSettings, readLoaderTarget, restoreLoader, verifyInjection } from "../setup.mjs";

const root = mkdtempSync(join(tmpdir(), "equicord-setup-test-"));
const local = join(root, "Local");
const discordRoot = join(local, "Discord");
const exePackage = join(root, "Roaming", "Equicord", "equicord.asar");
const settingsDirectory = join(root, "Roaming", "Equicord", "settings");
const sourceBuild = join(root, "Source with spaces & quotes'", "dist", "desktop");

function file(filename, text) {
    mkdirSync(resolve(filename, ".."), { recursive: true });
    writeFileSync(filename, text);
}

function loaderArchive(target) {
    const code = "require(" + JSON.stringify(target) + ")";
    const header = JSON.stringify({ files: { "index.js": { size: code.length, offset: "0" } } });
    const prefix = Buffer.alloc(16);
    const aligned = Math.ceil(Buffer.byteLength(header) / 4) * 4;
    prefix.writeUInt32LE(4, 0);
    prefix.writeUInt32LE(aligned + 8, 4);
    prefix.writeUInt32LE(aligned + 4, 8);
    prefix.writeUInt32LE(Buffer.byteLength(header), 12);
    return Buffer.concat([prefix, Buffer.from(header.padEnd(aligned, "0")), Buffer.from(code)]);
}

try {
    const older = join(discordRoot, "app-1.0.999", "resources");
    const resources = join(discordRoot, "app-1.0.1000", "resources");
    file(join(older, "app.asar"), "original app");
    file(join(resources, "app.asar"), loaderArchive(exePackage));
    file(exePackage, "existing packaged Equicord");
    file(join(resources, "_app.asar"), "original Discord archive");
    file(join(settingsDirectory, "settings.json"), JSON.stringify({ plugins: { Existing: { enabled: true } } }));
    file(join(settingsDirectory, "quickCss.css"), "body { color: red; }");

    let detected = detectDiscords(local);
    assert.equal(detected.length, 1);
    assert.equal(detected[0].kind, "Equicord installed with the .exe");
    assert.equal(detected[0].resources, resources, "Discord version detection is numeric");
    assert.equal(readLoaderTarget(join(resources, "app.asar")), exePackage);
    assert.equal(inspectDiscord(join(root, "missing")), null);
    assert.equal(verifyInjection(resources, resolve(sourceBuild, "../..")), false);

    const backup = backupInstallation(detected[0], settingsDirectory, join(root, "backups"));
    assert.equal(readFileSync(join(backup, "settings/quickCss.css"), "utf8"), "body { color: red; }");
    assert.equal(readFileSync(join(backup, "_app.asar"), "utf8"), "original Discord archive");
    file(join(resources, "app.asar"), loaderArchive(sourceBuild));
    assert.equal(verifyInjection(resources, resolve(sourceBuild, "../..")), true);
    assert.equal(inspectDiscord(discordRoot).kind, "Equicord source build");
    restoreLoader(resources, backup);
    assert.equal(readLoaderTarget(join(resources, "app.asar")), exePackage, "A failed injection can restore the previous .exe loader");
    rmSync(join(resources, "app.asar"));
    file(join(resources, "app.asar/index.js"), "require(" + JSON.stringify(join(sourceBuild, "patcher.js")) + ")");
    assert.equal(inspectDiscord(discordRoot).kind, "Equicord source build", "Older directory loaders are detected");
    assert.equal(verifyInjection(resources, resolve(sourceBuild, "../..")), true);
    restoreLoader(resources, backup);
    assert.equal(inspectDiscord(discordRoot).kind, "Equicord installed with the .exe");

    const canaryRoot = join(local, "DiscordCanary");
    file(join(canaryRoot, "app-1.2.3/resources/app.asar"), "stock Discord");
    file(join(canaryRoot, "app-1.2.3/DiscordCanary.exe"), "fixture");
    assert.equal(detectDiscords(local).length, 2);
    assert.equal(detectDiscords(local, join(canaryRoot, "app-1.2.3/DiscordCanary.exe"))[0].channel, "canary");

    const current = { theme: "dark", plugins: {
        ActivityTracker: { enabled: false, trackedUsers: ["example-user"], autoRefreshProfiles: true },
        GoLiveBypass: { onboardingCompleted: true, goLive: false, secret: "example-secret" },
        Existing: { enabled: true },
    } };
    const saved = { theme: "light", plugins: {
        GoLiveBypass: { enabled: true, onboardingSkipped: true, onboardingCompleted: false, goLive: true },
        Existing: { enabled: false },
    } };
    const merged = mergeSetupSettings(current, saved);
    assert.equal(merged.theme, "dark");
    assert.equal(merged.plugins.Existing.enabled, true);
    assert.deepEqual(merged.plugins.ActivityTracker.trackedUsers, ["example-user"]);
    assert.equal(merged.plugins.ActivityTracker.autoRefreshProfiles, true);
    assert.equal(merged.plugins.ActivityTracker.enabled, true);
    assert.equal(merged.plugins.GoLiveBypass.onboardingCompleted, true);
    assert.equal(merged.plugins.GoLiveBypass.goLive, false);
    assert.equal(merged.plugins.GoLiveBypass.secret, "example-secret");
    assert.equal(merged.autoUpdate, false);
    const fresh = mergeSetupSettings({}, saved);
    assert.equal(fresh.plugins.ActivityTracker.autoRefreshProfiles, false);
    assert.equal(fresh.plugins.GoLiveBypass.goLive, undefined);
    assert.equal(fresh.plugins.GoLiveBypass.onboardingCompleted, undefined);
    assert.equal(fresh.plugins.GoLiveBypass.onboardingSkipped, undefined);
    assert.throws(() => mergeSetupSettings([], saved), /invalid/);
    assert.throws(() => mergeSetupSettings({ plugins: [] }, saved), /invalid/);
    assert.ok(existsSync(exePackage), "Detection and migration backups retain the previous Equicord package");
    console.log("Setup tests passed: packaged/source detection, custom locations, loader verification, rollback and settings preservation.");
} finally {
    if (!resolve(root).startsWith(resolve(tmpdir()) + "/") && !resolve(root).startsWith(resolve(tmpdir()) + "\\")) throw new Error("Invalid test cleanup directory.");
    rmSync(root, { recursive: true, force: true });
}
