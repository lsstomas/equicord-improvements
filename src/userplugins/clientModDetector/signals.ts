/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export type ModSignal = "fakeNitro" | "invisibleChat" | "profileTheme" | "usrbg" | "userpfp";

export const SIGNAL_LABELS: Record<ModSignal, string> = {
    fakeNitro: "Sent an emoji or sticker the FakeNitro way",
    invisibleChat: "Sent a hidden InvisibleChat message",
    profileTheme: "Has a FakeProfileThemes code hidden in their bio",
    usrbg: "Listed in the USRBG banner database",
    userpfp: "Listed in the UserPFP avatar database"
};

// Discord never links emojis itself, and FakeNitro always adds these parameters to the link.
const FAKE_NITRO_REGEX = /https?:\/\/(?:cdn\.discordapp\.com\/emojis|media\.discordapp\.net\/stickers)\/\d+\.\w+\?\S*name=\S*lossless=true/;
const INVISIBLE_CHAT_REGEX = /( \u200c|\u200d |[\u2060-\u2064])[^\u200b]/;
const PROFILE_THEME_REGEX = /\[#[a-fA-F0-9]{1,6},#[a-fA-F0-9]{1,6}\]/;

const TAG_FIRST = 0xe0000;
const TAG_LAST = 0xe007f;

export function getMessageSignals(content: string | undefined): ModSignal[] {
    if (!content) return [];

    const signals: ModSignal[] = [];
    if (FAKE_NITRO_REGEX.test(content)) signals.push("fakeNitro");
    if (INVISIBLE_CHAT_REGEX.test(content)) signals.push("invisibleChat");
    return signals;
}

export function hasProfileThemeCode(bio: string | undefined): boolean {
    if (!bio) return false;

    let hidden = "";
    for (const char of bio) {
        const code = char.codePointAt(0)!;
        if (code >= TAG_FIRST && code <= TAG_LAST) hidden += String.fromCodePoint(code - TAG_FIRST);
    }

    return PROFILE_THEME_REGEX.test(hidden);
}

export function describeSignals(signals: ModSignal[]): string {
    return `Modified client signs: ${signals.map(signal => SIGNAL_LABELS[signal]).join("; ")}`;
}
