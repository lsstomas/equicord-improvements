/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export type VoiceStateKey = "selfMute" | "selfDeaf";

export interface FakeVoiceFlags {
    selfMute: boolean;
    selfDeaf: boolean;
}

export interface VoiceStatePayload {
    selfMute?: boolean;
    selfDeaf?: boolean;
    selfVideo?: boolean;
    [key: string]: unknown;
}

export function createDefaultFlags(): FakeVoiceFlags {
    return { selfMute: false, selfDeaf: false };
}

export function applyOverrides(
    original: VoiceStatePayload,
    flags: Readonly<FakeVoiceFlags>
): VoiceStatePayload {
    const result = { ...original };
    if (flags.selfMute) result.selfMute = true;
    if (flags.selfDeaf) {
        result.selfDeaf = true;
        result.selfMute = true;
    }
    return result;
}
