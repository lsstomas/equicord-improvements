/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/*
 * Go Live: enquanto estiver ligado, o gateway e a mídia do Discord saem pelo túnel.
 *
 * O servidor decide o bloqueio pelo IP do gateway quando a sessão abre, e o vídeo só chega com a
 * mídia saindo por IP de fora do Brasil. Todo o resto (API, CDN) fica fora do túnel pelo filtro de
 * IP. Na abertura o gateway espera o túnel subir: se conectasse antes, a sessão nasceria bloqueada.
 *
 * Quem confirma a rota é uma sonda real pelo mesmo filtro. Rota morta nunca prende o Discord: o
 * túnel desliga na hora, ele segue pela rede normal, e a recuperação acontece por fora.
 *
 * A sonda HTTP sozinha não basta: o gateway já ficou minutos sem conectar sem ela acusar nada. Por
 * isso o renderer avisa quando a sessão cai, e uma rota só volta a valer depois de entregar o
 * OP_HELLO de verdade.
 */

import { resolve4 } from "node:dns/promises";

export type GoLiveState = "off" | "starting" | "active" | "fallback" | "unavailable";

export interface GoLiveStatus {
    state: GoLiveState;
    server: string | null;
    country: string | null;
    latencyMs: number | null;
    error: string | null;
}

export interface GoLiveTunnel {
    hasRoute(): boolean;
    isBusy(): boolean;
    /** Liga sem a verificação completa; false quando algo pede o caminho normal. */
    startFast(allowedIps: string): Promise<boolean>;
    currentServer(): string | null;
    start(allowedIps: string): Promise<{ success: boolean; error?: string; }>;
    stop(): Promise<{ success: boolean; error?: string; }>;
    /** Gera uma rota evitando os servidores da lista. */
    rotate(avoid: string[]): Promise<{ success: boolean; server?: string | null; error?: string; }>;
}

export interface GoLiveSession {
    setProxy(config: { mode: "direct"; } | { mode: "pac_script"; pacScript: string; }): Promise<void>;
}

export interface GoLiveProbeSession {
    fetch(url: string, init?: { signal?: AbortSignal; cache?: "no-store"; }): Promise<{ ok: boolean; text(): Promise<string>; }>;
}

export interface GoLiveOptions {
    session: GoLiveSession;
    probeSession: GoLiveProbeSession;
    tunnel: GoLiveTunnel;
    log(level: "info" | "warn" | "error", message: string, data?: Record<string, unknown>): void;
    resolveGateway?(): Promise<string[]>;
    /** Abre o gateway de verdade e espera o OP_HELLO. */
    gatewayHello?(timeoutMs: number): Promise<boolean>;
    now?(): number;
    sleep?(ms: number): Promise<void>;
}

const TRACE_URL = "https://gateway.discord.gg/cdn-cgi/trace";
const BLOCKED_COUNTRY = "BR";
const CHECK_INTERVAL_MS = 30_000;
const PROBE_TIMEOUT_MS = 4_000;
const PROBE_RETRY_DELAY_MS = 1_500;
const STARTUP_PROBES = 3;
// Na abertura a sonda corre contra o gateway, que tenta conectar uns 1,7 s depois do plugin abrir.
const BOOT_PROBES = 5;
const BOOT_PROBE_DELAY_MS = 300;
const BOOT_PROBE_TIMEOUT_MS = 2_000;
const HOLD_LIMIT_MS = 15_000;
const ROUTE_ATTEMPTS = 2;
const RECOVERY_BACKOFF_MS = 5 * 60_000;
const GATEWAY_URL = "wss://gateway.discord.gg/?v=9&encoding=json";
const GATEWAY_HELLO_TIMEOUT_MS = 6_000;
// Dentro desta janela um novo aviso significa que religar a rota não resolveu.
const GATEWAY_TROUBLE_WINDOW_MS = 3 * 60_000;

// Toda a mídia observada veio de 104.29.0.0/16; o bloco 66.22 é o histórico do Discord.
const MEDIA_RANGES = ["104.29.0.0/16", "66.22.192.0/18"];
// O gateway e a sinalização de voz ficam nos finais .234; .232 e .233 são API e CDN.
const GATEWAY_ADDRESSES = Array.from({ length: 11 }, (_, index) => `162.159.${128 + index}.234`);
// Porta fechada de propósito: o gateway falha e tenta de novo, sem nunca sair pela rede direta.
const HOLD_PROXY = "SOCKS5 127.0.0.1:9";

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

export function buildAllowedIps(extraGateways: readonly string[] = []): string {
    const gateways = new Set([...GATEWAY_ADDRESSES, ...extraGateways.filter(address => IPV4.test(address))]);
    return [...MEDIA_RANGES, ...[...gateways].map(address => `${address}/32`)].join(", ");
}

export function buildHoldPacUrl(): string {
    const script = `function FindProxyForURL(url, host) {
    host = host.toLowerCase();
    if (host === "gateway.discord.gg" || shExpMatch(host, "gateway-*.discord.gg")) return "${HOLD_PROXY}";
    return "DIRECT";
}`;
    return `data:application/x-ns-proxy-autoconfig;base64,${Buffer.from(script).toString("base64")}`;
}

// A rede do processo principal não passa pelo freio de PAC, então isto mede o túnel mesmo com o
// gateway do renderer preso. Sem WebSocket no runtime a resposta é a da sonda HTTP.
function openGatewayHello(timeoutMs: number): Promise<boolean> {
    if (typeof WebSocket !== "function") return Promise.resolve(true);
    return new Promise(done => {
        const socket = new WebSocket(GATEWAY_URL);
        const finish = (ok: boolean) => {
            clearTimeout(timer);
            try { socket.close(); } catch { /* já fechado */ }
            done(ok);
        };
        const timer = setTimeout(() => finish(false), timeoutMs);
        socket.onmessage = event => finish(String(event.data).includes('"op":10'));
        socket.onerror = () => finish(false);
    });
}

export function shouldStartAtBoot(settings: { enabled?: unknown; goLive?: unknown; }): boolean {
    return settings.enabled === true && settings.goLive === true;
}

export function parseTraceCountry(body: string): string | null {
    return /^loc=([A-Z]{2})$/m.exec(body)?.[1] ?? null;
}

export class GoLive {
    private readonly options: GoLiveOptions;
    private readonly resolveGateway: NonNullable<GoLiveOptions["resolveGateway"]>;
    private readonly gatewayHello: NonNullable<GoLiveOptions["gatewayHello"]>;
    private readonly now: NonNullable<GoLiveOptions["now"]>;
    private readonly sleep: NonNullable<GoLiveOptions["sleep"]>;

    private enabled = false;
    private state: GoLiveState = "off";
    private country: string | null = null;
    private latencyMs: number | null = null;
    private error: string | null = null;
    private holding = false;
    private holdTimer: ReturnType<typeof setTimeout> | null = null;
    private checkTimer: ReturnType<typeof setInterval> | null = null;
    private nextRecoveryAt = 0;
    private gatewayTroubleUntil = 0;
    private restartedForGateway = false;
    private queue: Promise<unknown> = Promise.resolve();

    public constructor(options: GoLiveOptions) {
        this.options = options;
        this.resolveGateway = options.resolveGateway ?? (() => resolve4("gateway.discord.gg"));
        this.gatewayHello = options.gatewayHello ?? openGatewayHello;
        this.now = options.now ?? Date.now;
        this.sleep = options.sleep ?? (ms => new Promise(done => setTimeout(done, ms)));
    }

    public status(): GoLiveStatus {
        const server = this.state === "off" ? null : this.options.tunnel.currentServer();
        return { state: this.state, server, country: this.country, latencyMs: this.latencyMs, error: this.error };
    }

    // Separado do `configure` porque precisa valer antes de tudo que demora na abertura.
    public async holdGateway(): Promise<void> {
        if (this.holding) return;
        this.holding = true;
        await this.options.session.setProxy({ mode: "pac_script", pacScript: buildHoldPacUrl() });
        this.holdTimer = setTimeout(() => {
            this.options.log("warn", "Go Live: o túnel demorou demais, liberando o gateway");
            void this.releaseGateway();
        }, HOLD_LIMIT_MS);
        this.holdTimer.unref?.();
    }

    // Só na abertura, antes da verificação completa do plugin, que leva vários segundos. Se não
    // der, nada mudou e o `configure` segue o caminho normal com o gateway ainda preso.
    public startFast(): Promise<GoLiveStatus> {
        return this.serial(async () => {
            if (!this.options.tunnel.hasRoute()) return;
            if (!await this.options.tunnel.startFast(buildAllowedIps(await this.gatewayAddresses()))) return;
            this.setState("starting");
            if (!await this.probeUntilReady(BOOT_PROBES, BOOT_PROBE_DELAY_MS, BOOT_PROBE_TIMEOUT_MS)) return;
            this.enabled = true;
            this.startChecks();
            await this.releaseGateway();
            this.setState("active");
            this.error = null;
        });
    }

    public configure(enabled: boolean): Promise<GoLiveStatus> {
        return this.serial(() => this.apply(enabled));
    }

    public checkNow(): Promise<GoLiveStatus> {
        return this.serial(() => this.check());
    }

    public gatewayDown(): Promise<GoLiveStatus> {
        return this.serial(() => this.handleGatewayDown());
    }

    public settled(): Promise<void> {
        return this.queue.then(() => undefined);
    }

    public dispose(): void {
        this.enabled = false;
        this.state = "off";
        this.stopChecks();
        if (this.holdTimer !== null) clearTimeout(this.holdTimer);
        this.holdTimer = null;
    }

    private serial(operation: () => Promise<void>): Promise<GoLiveStatus> {
        const next = this.queue.catch(() => undefined).then(operation).then(() => this.status());
        this.queue = next;
        return next;
    }

    private async apply(enabled: boolean): Promise<void> {
        this.enabled = enabled;
        if (!enabled) {
            this.stopChecks();
            await this.releaseGateway();
            if (this.state !== "off") {
                const stopped = await this.options.tunnel.stop();
                if (!stopped.success) this.options.log("error", "Go Live: o túnel não desligou", { erro: stopped.error });
            }
            this.setState("off");
            this.clearReadings();
            this.error = null;
            return;
        }
        if (this.state === "active" || this.state === "fallback") return;

        this.startChecks();
        await this.bringUp();
    }

    private async bringUp(): Promise<void> {
        this.setState("starting");
        await this.holdGateway();
        if (!this.options.tunnel.hasRoute()) {
            await this.releaseGateway();
            this.setState("unavailable");
            this.error = "Choose a route first.";
            return;
        }
        if (await this.connect()) {
            await this.releaseGateway();
            this.setState("active");
            this.error = null;
            return;
        }
        await this.recover();
    }

    // Liga o túnel e só aceita a rota depois de a sonda sair por outro país.
    private async connect(verifyGateway = false): Promise<boolean> {
        const started = await this.options.tunnel.start(buildAllowedIps(await this.gatewayAddresses()));
        if (!started.success) {
            this.error = started.error ?? "The tunnel didn't start.";
            this.options.log("warn", "Go Live: o túnel não ligou", { erro: this.error });
            return false;
        }
        if (!await this.probeUntilReady()) return false;
        if (!verifyGateway) return true;
        const answered = await this.gatewayHello(GATEWAY_HELLO_TIMEOUT_MS);
        if (!answered) this.options.log("warn", "Go Live: a rota responde, mas não entrega o gateway");
        return answered;
    }

    private async probeUntilReady(attempts = STARTUP_PROBES, delayMs = PROBE_RETRY_DELAY_MS, timeoutMs = PROBE_TIMEOUT_MS): Promise<boolean> {
        for (let attempt = 0; attempt < attempts; attempt++) {
            if (attempt > 0) await this.sleep(delayMs);
            if (await this.probe(timeoutMs)) return true;
        }
        return false;
    }

    private async gatewayAddresses(): Promise<string[]> {
        try {
            return await this.resolveGateway();
        } catch {
            return [];
        }
    }

    private async check(): Promise<void> {
        if (!this.enabled || this.options.tunnel.isBusy()) return;

        if (this.state === "unavailable") {
            if (this.options.tunnel.hasRoute()) await this.bringUp();
            return;
        }
        if (this.state === "fallback") {
            if (this.now() >= this.nextRecoveryAt) await this.recover();
            return;
        }
        if (await this.probe()) return;

        await this.sleep(PROBE_RETRY_DELAY_MS);
        if (await this.probe()) return;
        this.options.log("warn", "Go Live: a rota parou de responder");
        await this.recover();
    }

    // Primeiro aviso com o gateway respondendo é oscilação do Discord: ele mesmo reconecta. Fora
    // isso, religa a rota com o gateway preso, para ele não abrir a sessão pela rede normal e nascer
    // bloqueado. Se o aviso se repetir, a rota não serve mais.
    private async handleGatewayDown(): Promise<void> {
        if (!this.enabled || this.state !== "active" || this.options.tunnel.isBusy()) return;

        const now = this.now();
        const recent = now < this.gatewayTroubleUntil;
        if (!recent) this.restartedForGateway = false;
        this.gatewayTroubleUntil = now + GATEWAY_TROUBLE_WINDOW_MS;

        const httpOk = await this.probe();
        const helloOk = await this.gatewayHello(GATEWAY_HELLO_TIMEOUT_MS);
        this.options.log("warn", "Go Live: a sessão do gateway caiu", { servidor: this.options.tunnel.currentServer(), httpOk, helloOk, recent });
        if (helloOk && !recent) return;

        if (!this.restartedForGateway) {
            this.restartedForGateway = true;
            this.setState("starting");
            await this.holdGateway();
            await this.options.tunnel.stop();
            if (await this.connect(true)) {
                await this.releaseGateway();
                this.finishRecovery();
                return;
            }
        }
        await this.recover(true);
    }

    // Tenta a rota atual de novo (uma queda pode ser passageira) e depois outras. O Discord fica
    // na rede normal durante tudo isso, porque gerar uma rota leva bem mais que uma reconexão.
    private async recover(skipCurrentRoute = false): Promise<void> {
        await this.options.tunnel.stop();
        await this.releaseGateway();
        this.setState("fallback");
        this.clearReadings();
        this.error = "Looking for a route that responds…";

        const avoid: string[] = [];
        if (!skipCurrentRoute) {
            if (await this.connect(true)) return this.finishRecovery();
            await this.options.tunnel.stop();
        }

        for (let attempt = 0; attempt < ROUTE_ATTEMPTS; attempt++) {
            const server = this.options.tunnel.currentServer();
            if (server !== null) avoid.push(server);
            const rotated = await this.options.tunnel.rotate(avoid);
            if (!rotated.success) {
                this.options.log("warn", "Go Live: não consegui gerar outra rota", { erro: rotated.error });
                break;
            }
            if (await this.connect(true)) return this.finishRecovery();
            await this.options.tunnel.stop();
        }

        this.nextRecoveryAt = this.now() + RECOVERY_BACKOFF_MS;
        this.error = "No route is responding. Discord stays on your normal network and keeps retrying.";
        this.options.log("warn", "Go Live: nenhuma rota respondeu");
    }

    private finishRecovery(): void {
        this.setState("active");
        this.error = null;
        this.options.log("info", "Go Live: rota recuperada", { servidor: this.options.tunnel.currentServer() });
    }

    private async probe(timeoutMs = PROBE_TIMEOUT_MS): Promise<boolean> {
        const startedAt = this.now();
        try {
            const response = await this.options.probeSession.fetch(TRACE_URL, { signal: AbortSignal.timeout(timeoutMs), cache: "no-store" });
            const country = response.ok ? parseTraceCountry(await response.text()) : null;
            if (country === null || country === BLOCKED_COUNTRY) return false;
            this.country = country;
            this.latencyMs = this.now() - startedAt;
            return true;
        } catch {
            return false;
        }
    }

    private async releaseGateway(): Promise<void> {
        if (this.holdTimer !== null) clearTimeout(this.holdTimer);
        this.holdTimer = null;
        if (!this.holding) return;
        this.holding = false;
        await this.options.session.setProxy({ mode: "direct" });
    }

    private clearReadings(): void {
        this.country = null;
        this.latencyMs = null;
    }

    private setState(next: GoLiveState): void {
        if (next === this.state) return;
        this.options.log(next === "fallback" || next === "unavailable" ? "warn" : "info", `Go Live: ${this.state} -> ${next}`);
        this.state = next;
    }

    private startChecks(): void {
        if (this.checkTimer !== null) return;
        this.checkTimer = setInterval(() => void this.checkNow().catch(error => this.options.log("error", "Go Live: falha na checagem", { erro: String(error) })), CHECK_INTERVAL_MS);
        this.checkTimer.unref?.();
    }

    private stopChecks(): void {
        if (this.checkTimer !== null) clearInterval(this.checkTimer);
        this.checkTimer = null;
    }
}
