/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { IpcMainInvokeEvent } from "electron";

import { writeArchiveDay } from "./archiveFile";

export function writeArchive(_: IpcMainInvokeEvent, accountId: string, day: string, content: string) {
    return writeArchiveDay("VoiceChannelLog", accountId, day, content);
}
