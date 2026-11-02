/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Decide quando o gateway ficou tempo demais fora. Antes da primeira conexão nada conta: a abertura
// espera o túnel de propósito. Depois de avisar, a contagem recomeça para repetir o aviso.
export class GatewayWatch {
    private seenConnected = false;
    private downSince: number | null = null;

    public constructor(private readonly limitMs: number) { }

    public observe(connected: boolean, now: number): boolean {
        if (connected) {
            this.seenConnected = true;
            this.downSince = null;
            return false;
        }
        if (!this.seenConnected) return false;
        if (this.downSince === null) {
            this.downSince = now;
            return false;
        }
        if (now - this.downSince < this.limitMs) return false;
        this.downSince = now;
        return true;
    }
}
