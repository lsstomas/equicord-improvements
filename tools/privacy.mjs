// Settings filter and the check that decides what may reach this public repository.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

// The "n" covers IDs written as BigInt in code.
const DISCORD_ID = /\b\d{17,20}(?=n?\b)/g;
const MAX_SAFE_NUMBER = 1e12;

const isSafeValue = value => typeof value === "boolean" || (typeof value === "number" && Math.abs(value) < MAX_SAFE_NUMBER);

function keepSafeValues(source) {
    return Object.fromEntries(Object.entries(source).filter(([, value]) => isSafeValue(value)));
}

/**
 * An allowlist instead of a blocklist. Text, lists and objects stay out, because that's where
 * IDs, names and links live, so a new option can never leak by default.
 */
export function sanitizeSettings(settings) {
    const plugins = {};

    for (const [name, config] of Object.entries(settings.plugins ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
        if (config && typeof config === "object") plugins[name] = keepSafeValues(config);
    }

    if (plugins.GoLiveBypass) {
        for (const key of ["goLive", "gatewayProxy", "onboardingCompleted", "onboardingSkipped"]) delete plugins.GoLiveBypass[key];
    }

    return { ...keepSafeValues(settings), plugins };
}

export const findDiscordIds = text => text.match(DISCORD_ID) ?? [];

/** Real IDs from this machine: settings, plus the folders named after tracked people. */
export function collectPrivateIds(settingsText, extraNames = []) {
    return new Set([...findDiscordIds(settingsText), ...extraNames.flatMap(findDiscordIds)]);
}

const SECRET_PATTERNS = [
    [/\bmfa\.[\w-]{40,}/, "Discord token"],
    [/\b[MNO][A-Za-z\d_-]{23,27}\.[\w-]{6}\.[\w-]{25,}/, "Discord token"],
    [/\bgh[pousr]_[A-Za-z\d]{30,}/, "GitHub token"],
    [/\bsk-[A-Za-z\d]{20,}/, "API key"],
    [/[A-Za-z]:\\+Users\\+\w+/, "personal path"],
    [/\/mnt\/c\/Users\/\w+/, "personal path"],
    [/\/home\/\w+/, "personal path"],
    [/[\w.+-]+@(?:gmail|hotmail|outlook|yahoo)\.\w+/i, "email address"]
];

const FORBIDDEN_FILE = /(\.jsonl|\.log|\.private\.json|equicord-all-backup.*)$/;
const SKIPPED = new Set([".git", "node_modules", "LICENSE", "privacy.mjs", "privacy.test.mjs"]);

function listFiles(directory) {
    return readdirSync(directory).flatMap(name => {
        if (SKIPPED.has(name)) return [];

        const path = join(directory, name);
        return statSync(path).isDirectory() ? listFiles(path) : [path];
    });
}

/** Returns the problems found. Empty means it's safe to publish. */
export function checkRepository(root, privateIds = new Set()) {
    const problems = [];

    for (const path of listFiles(root)) {
        const file = relative(root, path).replaceAll("\\", "/");
        if (FORBIDDEN_FILE.test(file)) problems.push(`${file}: forbidden file`);

        const text = readFileSync(path, "utf8");

        for (const [pattern, label] of SECRET_PATTERNS) {
            if (pattern.test(text)) problems.push(`${file}: ${label}`);
        }

        for (const id of findDiscordIds(text)) {
            if (privateIds.has(id)) problems.push(`${file}: real Discord ID`);
            else if (file.startsWith("settings/")) problems.push(`${file}: ID in settings`);
        }
    }

    return [...new Set(problems)];
}
