/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { app, IpcMainInvokeEvent } from "electron";
import { existsSync } from "fs";
import { mkdir, writeFile } from "fs/promises";
import { join } from "path";

import { writeArchiveDay } from "../../equicordplugins/voiceChannelLog/archiveFile";

const IMAGE_HOST = "cdn.discordapp.com";
const ID_REGEX = /^\d+$/;
const HASH_REGEX = /^(a_)?[0-9a-f]+$/;

export function writeArchive(_: IpcMainInvokeEvent, accountId: string, day: string, content: string) {
    return writeArchiveDay("ActivityTracker", accountId, day, content);
}

/** Keeps a copy of a profile image, which Discord may delete once it's replaced. */
export async function saveImage(_: IpcMainInvokeEvent, userId: string, kind: "avatar" | "banner", hash: string, url: string) {
    if (!ID_REGEX.test(userId) || !HASH_REGEX.test(hash) || !["avatar", "banner"].includes(kind)) throw new Error("Invalid image");
    if (new URL(url).hostname !== IMAGE_HOST) throw new Error("Unknown image host");

    const directory = join(app.getPath("documents"), "Equicord Logs", "ActivityTracker", "images", userId);
    const file = join(directory, `${kind}-${hash}.${hash.startsWith("a_") ? "gif" : "png"}`);
    if (existsSync(file)) return;

    const response = await fetch(url);
    if (!response.ok) throw new Error(`Failed to download image: ${response.status}`);

    await mkdir(directory, { recursive: true });
    await writeFile(file, new Uint8Array(await response.arrayBuffer()));
}
