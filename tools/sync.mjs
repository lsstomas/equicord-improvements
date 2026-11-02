// Maintainer tool: copies plugins from a local Equicord build into this repository
// and regenerates the filtered settings. Stops if it finds anything personal.
//
// Usage: node tools/sync.mjs
// EQUICORD_SOURCE overrides the source path, which defaults to ../source.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { checkRepository, collectPrivateIds, sanitizeSettings } from "./privacy.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = resolve(process.env.EQUICORD_SOURCE ?? join(ROOT, "..", "source"));
const SETTINGS = process.env.EQUICORD_SETTINGS ?? join(process.env.APPDATA ?? "", "Equicord", "settings", "settings.json");
const LOGS = join(homedir(), "Documents", "Equicord Logs");

const USER_PLUGINS = ["activityTracker", "clientModDetector", "fakeDeafen", "fakeMedia", "goLiveBypass", "lastMessageDate", "voiceFakeDetector"];
const EDITED_PLUGINS = ["toastNotifications", "voiceChannelLog"];
const TESTS = ["benchVoiceChannelLog.mjs", "testActivityTracker.mjs", "testGoLive.mjs", "testToastVoiceTracking.mjs", "testUserplugins.mjs", "testVoiceChannelHistory.mjs"];

const LAST_ONLINE_COMMIT = "493727b2b3d048dd28fe2cab5921117621ac8b92";
const LAST_ONLINE_URL = `https://raw.githubusercontent.com/k1ng0p/LastOnlineTracker/${LAST_ONLINE_COMMIT}/index.tsx`;

// The fakeDeafen clone keeps its own Git data and installers, which don't belong here.
// GoLiveBypass's prebuilt helper comes from install.mjs, and its internal docs stay upstream.
const isExcluded = path => /[\\/](\.git|install\.ps1|install\.sh|goLiveBypass[\\/](bin|docs))($|[\\/])/.test(path);

const copyPlugin = (from, to) => {
    rmSync(to, { recursive: true, force: true });
    cpSync(from, to, { recursive: true, filter: path => !isExcluded(path) });
};

for (const name of USER_PLUGINS) copyPlugin(join(SOURCE, "src/userplugins", name), join(ROOT, "src/userplugins", name));
for (const name of EDITED_PLUGINS) copyPlugin(join(SOURCE, "src/equicordplugins", name), join(ROOT, "src/equicordplugins", name));

mkdirSync(join(ROOT, "tests"), { recursive: true });
for (const name of TESTS) cpSync(join(SOURCE, "scripts", name), join(ROOT, "tests", name));

// LastOnlineTracker declares no license, so only our change lives here, never the author's file.
const original = await fetch(LAST_ONLINE_URL).then(response => response.text());
const work = join(tmpdir(), `last-online-${process.pid}`);
mkdirSync(join(work, "a"), { recursive: true });
mkdirSync(join(work, "b"), { recursive: true });
writeFileSync(join(work, "a/index.tsx"), original);
cpSync(join(SOURCE, "src/userplugins/lastOnlineTracker/index.tsx"), join(work, "b/index.tsx"));

let patch = "";
try {
    execFileSync("git", ["-c", "core.autocrlf=false", "diff", "--no-index", "--no-color", "a/index.tsx", "b/index.tsx"], { cwd: work, stdio: "pipe" });
} catch (error) {
    patch = error.stdout.toString();
}
rmSync(work, { recursive: true, force: true });

mkdirSync(join(ROOT, "patches"), { recursive: true });
writeFileSync(join(ROOT, "patches/lastOnlineTracker.patch"), patch);

const settingsText = readFileSync(SETTINGS, "utf8");
mkdirSync(join(ROOT, "settings"), { recursive: true });
const publicSettings = sanitizeSettings(JSON.parse(settingsText));
// Go Live starts a tunnel, so it has to be each person's own choice.
delete publicSettings.plugins.GoLiveBypass?.goLive;
delete publicSettings.plugins.GoLiveBypass?.gatewayProxy;
writeFileSync(join(ROOT, "settings/settings.public.json"), `${JSON.stringify(publicSettings, null, 4)}\n`);

const names = [];
if (existsSync(join(LOGS, "VoiceChannelLog"))) names.push(...readdirSync(join(LOGS, "VoiceChannelLog")));
if (existsSync(join(LOGS, "ActivityTracker/images"))) names.push(...readdirSync(join(LOGS, "ActivityTracker/images")));

const problems = checkRepository(ROOT, collectPrivateIds(settingsText, names));
if (problems.length) {
    console.error(`Blocked, do not publish:\n${problems.join("\n")}`);
    process.exit(1);
}

console.log("Synced. No personal data found.");
