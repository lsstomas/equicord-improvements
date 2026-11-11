/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { proxyLazy } from "@utils/lazy";
import { zustandCreate } from "@webpack/common";

export type FakeMode = "mute" | "deafen" | "camera" | "screen";
export interface ModeState {
    active: boolean;
    pending: boolean;
    error: string | null;
}
type FakeState = Record<FakeMode, ModeState>;
type FakeStore = {
    <T>(selector: (state: FakeState) => T): T;
    getState(): FakeState;
    setState(state: Partial<FakeState>): void;
};

const inactive = (): ModeState => ({ active: false, pending: false, error: null });

export const fakeStore: FakeStore = proxyLazy(() => zustandCreate((): FakeState => ({
    mute: inactive(), deafen: inactive(), camera: inactive(), screen: inactive()
})));

export function setFakeMode(mode: FakeMode, state: Partial<ModeState>) {
    fakeStore.setState({ [mode]: { ...fakeStore.getState()[mode], ...state } });
}

export function resetFakeModes(...modes: FakeMode[]) {
    for (const mode of modes) fakeStore.setState({ [mode]: inactive() });
}
