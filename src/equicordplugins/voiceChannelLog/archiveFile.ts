/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { app } from "electron";
import { mkdir, rename, writeFile } from "fs/promises";
import { join } from "path";

const DAY_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const ACCOUNT_REGEX = /^\w+$/;

/** Saves one day of logs in Documents. These values come from the renderer, so they can't choose the path. */
export async function writeArchiveDay(folder: string, accountId: string, day: string, content: string) {
    if (!DAY_REGEX.test(day) || !ACCOUNT_REGEX.test(accountId)) throw new Error("Invalid archive path");

    const directory = join(app.getPath("documents"), "Equicord Logs", folder, accountId);
    await mkdir(directory, { recursive: true });

    const file = join(directory, `${day}.jsonl`);
    const partial = `${file}.tmp`;

    // A crash halfway through must not damage a day that was already archived.
    await writeFile(partial, content, "utf8");
    await rename(partial, file);
}
