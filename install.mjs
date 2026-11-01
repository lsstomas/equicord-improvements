// Installs these plugins into an Equicord source folder.
//
// Usage: node install.mjs <path to Equicord> [--settings]
// With --settings, also applies the saved options. Close Discord first.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const applySettings = args.includes("--settings");
const SOURCE = resolve(args.find(arg => !arg.startsWith("--")) ?? process.env.EQUICORD_SOURCE ?? join(ROOT, "..", "source"));

const LAST_ONLINE_COMMIT = "493727b2b3d048dd28fe2cab5921117621ac8b92";
const LAST_ONLINE_URL = `https://raw.githubusercontent.com/k1ng0p/LastOnlineTracker/${LAST_ONLINE_COMMIT}/index.tsx`;
const LAST_ONLINE_PATH = "src/userplugins/lastOnlineTracker";

const PROTON_HELPER_URL = "https://github.com/bezumiya/GoLiveBypass/releases/download/v2.0.13/proton-confgen-2.0.13-win-x64.exe";
const PROTON_HELPER_SHA256 = "a00f8631ab357bf931797b0ab22500b9159e6409acd1ed74d6b6234e45c596bf";
const PROTON_HELPER_PATH = "src/userplugins/goLiveBypass/bin/win32-x64";

function getSettingsPath() {
    if (process.env.EQUICORD_SETTINGS) return process.env.EQUICORD_SETTINGS;

    const data = {
        win32: process.env.APPDATA,
        darwin: join(homedir(), "Library", "Application Support")
    }[platform()] ?? join(homedir(), ".config");

    return join(data, "Equicord", "settings", "settings.json");
}

if (!existsSync(join(SOURCE, "src/plugins")) || !existsSync(join(SOURCE, "package.json"))) {
    console.error(`No Equicord source found at ${SOURCE}.\nUsage: node install.mjs <path to Equicord> [--settings]`);
    process.exit(1);
}

cpSync(join(ROOT, "src"), join(SOURCE, "src"), { recursive: true });
cpSync(join(ROOT, "tests"), join(SOURCE, "scripts"), { recursive: true });

// This plugin declares no license, so its original file comes from the author.
const response = await fetch(LAST_ONLINE_URL);
if (!response.ok) {
    console.error(`Couldn't download LastOnlineTracker: HTTP ${response.status}`);
    process.exit(1);
}

mkdirSync(join(SOURCE, LAST_ONLINE_PATH), { recursive: true });
writeFileSync(join(SOURCE, LAST_ONLINE_PATH, "index.tsx"), await response.text());
execFileSync("git", ["apply", "--directory", LAST_ONLINE_PATH, "-p2", join(ROOT, "patches/lastOnlineTracker.patch")], { cwd: SOURCE, stdio: "inherit" });

// GoLiveBypass needs this prebuilt helper on Windows. It's too large to keep in Git, so it comes from the pinned release.
if (platform() === "win32") {
    const helper = await fetch(PROTON_HELPER_URL);
    if (!helper.ok) {
        console.error(`Couldn't download GoLiveBypass's Proton helper: HTTP ${helper.status}`);
        process.exit(1);
    }

    const binary = Buffer.from(await helper.arrayBuffer());
    if (createHash("sha256").update(binary).digest("hex") !== PROTON_HELPER_SHA256) {
        console.error("GoLiveBypass's Proton helper failed its checksum, so it wasn't installed.");
        process.exit(1);
    }

    mkdirSync(join(SOURCE, PROTON_HELPER_PATH), { recursive: true });
    writeFileSync(join(SOURCE, PROTON_HELPER_PATH, "proton-confgen.exe"), binary);
}

if (applySettings) {
    const path = getSettingsPath();
    const current = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
    const saved = JSON.parse(readFileSync(join(ROOT, "settings/settings.public.json"), "utf8"));

    const plugins = { ...current.plugins };
    for (const [name, config] of Object.entries(saved.plugins)) plugins[name] = { ...plugins[name], ...config };

    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ ...current, ...saved, plugins }, null, 4));
    console.log(`Options applied to ${path}`);
}

console.log("Plugins installed. Next, run these inside the Equicord folder:\n  pnpm build\n  pnpm inject");
