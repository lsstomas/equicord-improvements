/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { FakeMode } from "../fakeDeafen/state";

export function FakeIcon({ mode, className, width = 20, height = 20 }: { mode?: FakeMode; className?: string; width?: number; height?: number; }) {
    return <svg className={className} width={width} height={height} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {mode === "mute" ? <>
            <path d="M9 9v3a3 3 0 0 0 5.1 2.1M15 9.3V5a3 3 0 0 0-5.8-1M5 10v2a7 7 0 0 0 12 4.9M19 10v2M12 19v3M8 22h8M3 3l18 18" />
        </> : mode === "deafen" ? <>
            <path d="M4 13v-1a8 8 0 0 1 16 0v1M4 13H3v6h4v-6H4ZM20 13h1v6h-4v-6h3ZM3 3l18 18" />
        </> : mode === "camera" ? <>
            <rect x="3" y="6" width="12" height="12" rx="3" /><path d="m15 10 6-3v10l-6-3" />
        </> : mode === "screen" ? <>
            <rect x="2" y="3" width="20" height="14" rx="3" /><path d="M8 21h8M12 17v4M9 10l3-3 3 3M12 7v6" />
        </> : <>
            <path d="M3 5c3 2 6 2 9 0 3 2 6 2 9 0v6c0 5-5 9-9 10-4-1-9-5-9-10V5Z" />
            <path d="M6.5 10c1-1 2-1 3 0M14.5 10c1-1 2-1 3 0M8 15c2 2 6 2 8 0" />
        </>}
    </svg>;
}
