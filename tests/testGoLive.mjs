/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const load = async path => {
    const result = await build({
        entryPoints: [fileURLToPath(new URL(`../src/userplugins/goLiveBypass/${path}`, import.meta.url))],
        bundle: true, write: false, format: "cjs", platform: "node", external: ["electron"]
    });
    const module = { exports: {} };
    new Function("module", "exports", "require", result.outputFiles[0].text)(module, module.exports, createRequire(import.meta.url));
    return module.exports;
};

const { buildAllowedIps, buildHoldPacUrl, GoLive, parseTraceCountry, shouldStartAtBoot } = await load("go-live.ts");
const { sanitizeWireGuardConfig } = await load("vpn-types.ts");
const { fastStartAllowed } = await load("vpn-windows.ts");

function pacDecides(url, host) {
    const source = Buffer.from(url.split("base64,")[1], "base64").toString();
    const shExpMatch = (value, pattern) => new RegExp(`^${pattern.replace(/\./g, "\\.").replace(/\*/g, ".*")}$`).test(value);
    return new Function("shExpMatch", `${source}; return FindProxyForURL;`)(shExpMatch)(`https://${host}/`, host);
}

// O filtro: só gateway e mídia entram. API e CDN nunca.
{
    const allowed = buildAllowedIps().split(", ");
    assert.ok(allowed.includes("104.29.0.0/16"));
    assert.ok(allowed.includes("162.159.134.234/32"), "Gateway seen in the real test");
    assert.ok(allowed.includes("162.159.138.234/32"), "Voice signaling seen in the real test");
    assert.ok(!allowed.some(entry => /\.23[23]\/32$/.test(entry)), "API and CDN stay outside");
    assert.ok(!allowed.includes("0.0.0.0/0"));
    assert.ok(buildAllowedIps(["162.159.200.234"]).includes("162.159.200.234/32"), "Follows the gateway if DNS moves it");
    assert.ok(!buildAllowedIps(["not-an-ip, 0.0.0.0/0"]).includes("0.0.0.0/0"));
    assert.equal(new Set(allowed).size, allowed.length);
    assert.equal(new Set(buildAllowedIps(["162.159.134.234"]).split(", ")).size, allowed.length, "No duplicates");
}

// O perfil do Proton pede a rota padrão; o que vai para o WireSock é só o filtro.
{
    const raw = "[Interface]\nPrivateKey = a\nAddress = 10.2.0.2/32\nDNS = 10.2.0.1\n\n[Peer]\nPublicKey = b\nAllowedIPs = 0.0.0.0/0, ::/0\nEndpoint = 1.1.1.1:51820\n";
    const filtered = sanitizeWireGuardConfig(raw, "C:\\Discord.exe", "104.29.0.0/16");
    assert.match(filtered, /^AllowedIPs = 104\.29\.0\.0\/16\r?$/m);
    assert.doesNotMatch(filtered, /0\.0\.0\.0\/0/);
    assert.doesNotMatch(filtered, /^DNS/m);
    assert.match(filtered, /^#@ws:AllowedApps = C:\\Discord\.exe\r?$/m);
    assert.match(sanitizeWireGuardConfig(raw, "C:\\Discord.exe"), /AllowedIPs = 0\.0\.0\.0\/0, ::\/0/, "Without a filter nothing changes");
}

// O freio do gateway na abertura.
{
    const url = buildHoldPacUrl();
    assert.equal(pacDecides(url, "gateway.discord.gg"), "SOCKS5 127.0.0.1:9");
    assert.equal(pacDecides(url, "gateway-us-east1-b.discord.gg"), "SOCKS5 127.0.0.1:9");
    assert.equal(pacDecides(url, "discord.com"), "DIRECT");
    assert.equal(pacDecides(url, "c-gru20.discord.media"), "DIRECT");
}

// Ligar é uma escolha explícita: não depende do assistente, que pode ter sido pulado.
assert.equal(shouldStartAtBoot({ enabled: true, goLive: true, onboardingCompleted: false, onboardingSkipped: true }), true);
assert.equal(shouldStartAtBoot({ enabled: true, goLive: true, onboardingCompleted: true }), true);
assert.equal(shouldStartAtBoot({ enabled: true, goLive: false, onboardingCompleted: true }), false);
assert.equal(shouldStartAtBoot({ enabled: true }), false, "Off until turned on");
assert.equal(shouldStartAtBoot({ enabled: false, goLive: true }), false, "A disabled plugin never touches the network");

// O caminho rápido só vale quando está tudo como um fechamento limpo deixa. Saídas reais do sc.exe.
{
    const configPath = String.raw`C:\ProgramData\GoLiveBypass\plugin-vpn\wiresock-discord.conf`;
    const serviceConfig = String.raw`[SC] QueryServiceConfig SUCCESS

SERVICE_NAME: wiresock-client-service
        TYPE               : 10  WIN32_OWN_PROCESS
        START_TYPE         : 3   DEMAND_START
        ERROR_CONTROL      : 1   NORMAL
        BINARY_PATH_NAME   : "C:\Program Files\WireSock Secure Connect\sdk\wiresock-client.exe" service -config "${configPath}" -log-level none
        DISPLAY_NAME       : WireSock WireGuard VPN Client Service
`;
    const clean = {
        configPath,
        service: { code: 0, stdout: "        STATE              : 1  STOPPED \n" },
        serviceConfig: { code: 0, stdout: serviceConfig },
        proService: { code: 1060, stdout: "FAILED 1060" },
        processes: { code: 0, stdout: "INFO: No tasks are running which match the specified criteria.\n" },
    };
    assert.equal(fastStartAllowed(clean), true);
    assert.equal(fastStartAllowed({ ...clean, service: { code: 0, stdout: "STATE : 4  RUNNING" } }), false, "A running tunnel may be unfiltered");
    assert.equal(fastStartAllowed({ ...clean, service: { code: 1060, stdout: "" } }), false, "Not installed yet");
    assert.equal(fastStartAllowed({ ...clean, serviceConfig: { code: 0, stdout: serviceConfig.replace("wiresock-discord.conf", "other.conf") } }), false, "Another profile");
    assert.equal(fastStartAllowed({ ...clean, serviceConfig: { code: 0, stdout: serviceConfig.replace("DEMAND_START", "AUTO_START") } }), false);
    assert.equal(fastStartAllowed({ ...clean, serviceConfig: { code: 5, stdout: "" } }), false);
    assert.equal(fastStartAllowed({ ...clean, proService: { code: 0, stdout: "STATE : 4  RUNNING" } }), false, "An external tunnel");
    assert.equal(fastStartAllowed({ ...clean, proService: { code: 0, stdout: "STATE : 1  STOPPED" } }), true);
    assert.equal(fastStartAllowed({ ...clean, processes: { code: 0, stdout: "wiresock-client.exe  10688 Services" } }), false, "A tunnel outside the service");
    assert.equal(fastStartAllowed({ ...clean, processes: { code: 1, stdout: "" } }), false, "Unknown state goes the safe way");
}

assert.equal(parseTraceCountry("ip=1.2.3.4\nloc=MX\n"), "MX");
assert.equal(parseTraceCountry("<html>"), null);

function harness({ probes = ["MX"], hasRoute = true, startFails = false, canRotate = true, servers = ["MX-FREE#9"], fastAvailable = true } = {}) {
    const state = { probes: [...probes], hasRoute, startFails, canRotate, fastAvailable, busy: false, sleeps: [], server: servers[0], running: false, order: [], starts: 0, stops: 0, avoided: [], filters: [], logs: [], proxies: [], time: 0 };
    let next = 1;
    const session = {
        async setProxy(config) {
            state.proxies.push(config.mode);
            state.order.push(config.mode === "direct" ? "release" : "hold");
        },
    };
    const goLive = new GoLive({
        session,
        probeSession: {
            async fetch() {
                state.order.push("probe");
                const value = state.probes.length > 1 ? state.probes.shift() : state.probes[0];
                if (value === "fail") throw new Error("ERR_TIMED_OUT");
                return { ok: true, text: async () => `loc=${value}\n` };
            },
        },
        tunnel: {
            hasRoute: () => state.hasRoute,
            isBusy: () => state.busy,
            async startFast(allowedIps) {
                state.filters.push(allowedIps);
                state.order.push("startFast");
                if (!state.fastAvailable) return false;
                state.running = true;
                return true;
            },
            currentServer: () => state.server,
            async start(allowedIps) {
                state.starts++;
                state.filters.push(allowedIps);
                state.order.push("start");
                if (state.startFails) return { success: false, error: "UAC cancelled" };
                state.running = true;
                return { success: true };
            },
            async stop() {
                state.stops++;
                state.order.push("stop");
                state.running = false;
                return { success: true };
            },
            async rotate(avoid) {
                state.avoided.push([...avoid]);
                state.order.push("rotate");
                if (!state.canRotate) return { success: false, error: "custom profile" };
                state.server = servers[next++] ?? state.server;
                return { success: true, server: state.server };
            },
        },
        log: (level, message) => state.logs.push(`${level} ${message}`),
        resolveGateway: async () => ["162.159.130.234"],
        now: () => state.time,
        sleep: async ms => { state.sleeps.push(ms); },
    });
    return { goLive, state, cleanup: () => goLive.dispose() };
}

// Abertura: o gateway só é solto depois de a rota provar que saiu do país.
{
    const { goLive, state, cleanup } = harness();
    await goLive.holdGateway();
    const status = await goLive.configure(true);
    assert.equal(status.state, "active");
    assert.equal(status.country, "MX");
    assert.equal(status.server, "MX-FREE#9");
    assert.deepEqual(state.order, ["hold", "start", "probe", "release"]);
    assert.doesNotMatch(state.filters[0], /0\.0\.0\.0\/0/);

    // O start do plugin repete a chamada do boot: não pode religar nada.
    await goLive.configure(true);
    assert.equal(state.starts, 1);
    cleanup();
}

// Caminho rápido: liga e solta o gateway sem passar pela ativação completa.
{
    const { goLive, state, cleanup } = harness();
    await goLive.holdGateway();
    assert.equal((await goLive.startFast()).state, "active");
    assert.deepEqual(state.order, ["hold", "startFast", "probe", "release"]);
    assert.doesNotMatch(state.filters[0], /0\.0\.0\.0\/0/, "The fast path keeps the filter");

    // O configure que vem depois da verificação completa não pode religar nada.
    assert.equal((await goLive.configure(true)).state, "active");
    assert.equal(state.starts, 0);

    // E a rota segue vigiada: um túnel de caminho rápido morre igual aos outros.
    state.probes = ["fail"];
    assert.equal((await goLive.checkNow()).state, "fallback");
    cleanup();
}

// Na abertura a primeira sonda costuma pegar o WireGuard negociando, e cada milissegundo conta:
// o gateway tenta conectar cerca de 1,7 s depois de o plugin abrir.
{
    const { goLive, state, cleanup } = harness({ probes: ["fail", "MX"] });
    await goLive.holdGateway();
    assert.equal((await goLive.startFast()).state, "active");
    assert.deepEqual(state.sleeps, [300]);
    cleanup();
}

// Rota morta na abertura desiste logo, para o caminho completo agir antes do limite do gateway.
{
    const { goLive, state, cleanup } = harness({ probes: ["fail"] });
    await goLive.startFast();
    assert.equal(state.order.filter(step => step === "probe").length, 5);
    cleanup();
}

// Fora da abertura a espera normal continua.
{
    const { goLive, state, cleanup } = harness({ probes: ["fail", "MX"], fastAvailable: false });
    await goLive.configure(true);
    assert.deepEqual(state.sleeps, [1500]);
    cleanup();
}

// Algo fora do esperado: não toca em nada e o caminho completo assume, com o gateway ainda preso.
{
    const { goLive, state, cleanup } = harness({ fastAvailable: false });
    await goLive.holdGateway();
    assert.equal((await goLive.startFast()).state, "off");
    assert.deepEqual(state.order, ["hold", "startFast"]);
    assert.equal((await goLive.configure(true)).state, "active");
    assert.equal(state.starts, 1);
    cleanup();
}

// Sem rota: nem tenta.
{
    const { goLive, state, cleanup } = harness({ hasRoute: false });
    await goLive.startFast();
    assert.equal(state.order.includes("startFast"), false);
    cleanup();
}

// Rota morta no caminho rápido: o caminho completo recupera, sem prender o Discord.
{
    const { goLive, state, cleanup } = harness({ probes: ["fail"], servers: ["A", "B", "C"] });
    await goLive.holdGateway();
    assert.notEqual((await goLive.startFast()).state, "active");
    const status = await goLive.configure(true);
    assert.equal(status.state, "fallback");
    assert.equal(state.running, false);
    assert.equal(state.proxies.at(-1), "direct");
    cleanup();
}

// Desligar: para tudo, sem nada pedir reinício.
{
    const { goLive, state, cleanup } = harness();
    await goLive.configure(true);
    const off = await goLive.configure(false);
    assert.equal(off.state, "off");
    assert.equal(off.server, null);
    assert.equal(off.country, null);
    assert.equal(state.running, false);
    assert.equal(state.stops, 1);
    cleanup();
}

// Desligado sem nada rodando não pode parar um túnel de teste de rota.
{
    const { goLive, state, cleanup } = harness();
    await goLive.configure(false);
    assert.equal(state.stops, 0);
    cleanup();
}

// O túnel não sobe (ex.: permissão negada): solta o gateway, nunca deixa o Discord preso.
{
    const { goLive, state, cleanup } = harness({ startFails: true });
    await goLive.holdGateway();
    const status = await goLive.configure(true);
    assert.equal(status.state, "fallback");
    assert.equal(state.proxies.at(-1), "direct");
    assert.ok(state.order.indexOf("release") < state.order.lastIndexOf("start"), "Discord isn't waiting on the retries");
    cleanup();
}

// Sem rota preparada: não tenta nada e solta o gateway.
{
    const { goLive, state, cleanup } = harness({ hasRoute: false });
    await goLive.holdGateway();
    const status = await goLive.configure(true);
    assert.equal(status.state, "unavailable");
    assert.equal(state.starts, 0);
    assert.equal(state.proxies.at(-1), "direct");

    // A rota escolhida depois vale sem reiniciar.
    state.hasRoute = true;
    assert.equal((await goLive.checkNow()).state, "active");
    cleanup();
}

// Rota dá BR: o filtro não pegou, então não conta como funcionando.
{
    const { goLive, state, cleanup } = harness({ probes: ["BR"], servers: ["A", "B", "C"] });
    const status = await goLive.configure(true);
    assert.equal(status.state, "fallback");
    assert.equal(state.running, false, "A route that doesn't work never stays on");
    cleanup();
}

// Queda passageira: uma falha isolada não mexe em nada.
{
    const { goLive, state, cleanup } = harness({ probes: ["MX", "fail", "MX"] });
    await goLive.configure(true);
    assert.equal((await goLive.checkNow()).state, "active");
    assert.equal(state.stops, 0);
    cleanup();
}

// A rota morre, mas volta sozinha ao religar: não troca de servidor à toa.
{
    const { goLive, state, cleanup } = harness({ probes: ["MX", "fail", "fail", "MX"] });
    await goLive.configure(true);
    const status = await goLive.checkNow();
    assert.equal(status.state, "active");
    assert.equal(state.avoided.length, 0);
    assert.deepEqual(state.order.slice(-3), ["stop", "start", "probe"]);
    cleanup();
}

// A rota morre de vez: Discord vai para a rede normal e o plugin acha outra sozinho.
{
    const probes = ["MX", "fail", "fail", "fail", "fail", "fail", "fail", "US"];
    const { goLive, state, cleanup } = harness({ probes, servers: ["MX-FREE#9", "US-FREE#1"] });
    await goLive.configure(true);
    const status = await goLive.checkNow();
    assert.equal(status.state, "active");
    assert.equal(status.server, "US-FREE#1");
    assert.equal(status.country, "US");
    assert.deepEqual(state.avoided, [["MX-FREE#9"]]);
    assert.ok(state.order.indexOf("stop") < state.order.indexOf("rotate"), "The dead tunnel goes off before a new route is generated");
    cleanup();
}

// Nenhuma rota responde: fica na rede normal, avisa e não martela a API do Proton.
{
    const { goLive, state, cleanup } = harness({ probes: ["MX", "fail"], servers: ["A", "B", "C", "D"] });
    await goLive.configure(true);
    const status = await goLive.checkNow();
    assert.equal(status.state, "fallback");
    assert.match(status.error, /normal network/);
    assert.equal(state.running, false);
    assert.deepEqual(state.avoided, [["A"], ["A", "B"]]);

    const rotations = state.avoided.length;
    await goLive.checkNow();
    assert.equal(state.avoided.length, rotations, "Waits before trying again");

    state.time += 5 * 60_000;
    state.probes = ["MX"];
    assert.equal((await goLive.checkNow()).state, "active");
    cleanup();
}

// Perfil .conf próprio não tem outra rota para gerar.
{
    const { goLive, state, cleanup } = harness({ probes: ["fail"], canRotate: false });
    const status = await goLive.configure(true);
    assert.equal(status.state, "fallback");
    assert.equal(state.avoided.length, 1);
    assert.equal(state.running, false);
    cleanup();
}

// Teste de rota em andamento: o túnel para de propósito, e isso não é queda.
{
    const { goLive, state, cleanup } = harness({ probes: ["MX", "fail"] });
    await goLive.configure(true);
    state.busy = true;
    assert.equal((await goLive.checkNow()).state, "active");
    assert.equal(state.stops, 0);
    cleanup();
}

// Chamadas concorrentes (boot + start do plugin) ligam o túnel uma vez só.
{
    const { goLive, state, cleanup } = harness();
    await Promise.all([goLive.configure(true), goLive.configure(true)]);
    assert.equal(state.starts, 1);
    cleanup();
}

console.log("go-live: all tests passed");
