// Runs before every push. Compares against the real IDs when the settings file is available.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { checkRepository, collectPrivateIds } from "./privacy.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SETTINGS = process.env.EQUICORD_SETTINGS ?? join(process.env.APPDATA ?? "", "Equicord", "settings", "settings.json");

const privateIds = existsSync(SETTINGS) ? collectPrivateIds(readFileSync(SETTINGS, "utf8")) : new Set();
const problems = checkRepository(ROOT, privateIds);

if (problems.length) {
    console.error(`Push blocked:\n${problems.join("\n")}`);
    process.exit(1);
}
