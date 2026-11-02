/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { sendBotMessage } from "@api/Commands";
import { HeaderBarButton } from "@api/HeaderBar";
import { definePluginSettings } from "@api/Settings";
import { Button } from "@components/Button";
import { FormSwitch } from "@components/FormSwitch";
import { Paragraph } from "@components/Paragraph";
import { copyWithToast } from "@utils/discord";
import { Logger } from "@utils/Logger";
import { useAwaiter } from "@utils/react";
import definePlugin, { OptionType, PluginNative } from "@utils/types";
import type { RenderModalProps } from "@vencord/discord-types";
import { findStoreLazy } from "@webpack";
import { closeModal as closeDiscordModal, Constants, MaskedLink, Modal, openModal, React, RestAPI, SearchableSelect, showToast as showDiscordToast, TextArea, TextInput, useEffect, UserStore, useState } from "@webpack/common";

import { ControlPanel, type ControlPanelController, PANEL_TONE_LABEL, panelIconFor, PanelIconOff, type PanelTone,panelTone } from "./control-panel";
import type { GoLiveStatus } from "./go-live";
import {
    formatProtonRoutePing,
    isProtonRouteSelectable,
    mergeProtonRouteCatalog,
    protonLoginPresentation,
    type ProtonRouteCandidate,
    type ProtonRouteCatalogEntry,
    protonRouteLocation,
    type ProtonRouteProgressPhase,
    protonRouteStateLabel,
    protonRouteTierLabel,
    recommendProtonRoute,
    shouldMeasureRouteCatalogOnFailure,
    sortProtonRouteCandidates,
} from "./proton-manual-selection";
import {
    evaluateStreamClaim,
    evaluateStreamObservation,
    initialStreamClaimState,
    normalizeStreamClaim,
    type StreamClaimState,
    type StreamObservation,
    type StreamObservationStatus,
} from "./stability";
import { formatVpnRouteSummary, protonUsernamesMatch, safeDiagnosticDetail, type VpnPlatform, type VpnRouteInfo, vpnRouteStateLabel, type VpnState } from "./vpn-types";

// Ajuste local: o Equicord atual trocou showToast(texto, tipo) por showToast({ text, variant }).
// A API nova não renderiza componente, então os avisos "custom" mostram apenas o texto.
function showToast(text: string, type: "success" | "failure" | "custom", options?: { position?: number; duration?: number; component?: React.ReactNode; }) {
    showDiscordToast({
        text,
        variant: type === "failure" ? "critical" : type === "success" ? "success" : "default",
        ...(options?.duration === undefined ? {} : { duration: options.duration }),
    });
}

type PluginUpdateChannel = "stable" | "beta";

interface PluginUpdateStatus {
    current: string;
    channel: PluginUpdateChannel;
    enabled: boolean;
    pending: boolean;
    pendingVersion?: string;
    pendingChannel?: PluginUpdateChannel;
    lastCheckedAt: number | null;
    lastError: string | null;
}

interface PluginUpdateCheckResult {
    ok: boolean;
    current?: string;
    channel?: PluginUpdateChannel;
    latest?: string;
    available?: boolean;
    pending?: boolean;
    pendingChannel?: PluginUpdateChannel;
    error?: string;
}

interface PluginUpdateResult {
    ok: boolean;
    updated: boolean;
    current?: string;
    latest?: string;
    channel?: PluginUpdateChannel;
    pending?: boolean;
    pendingChannel?: PluginUpdateChannel;
    reloadRequired?: boolean;
    error?: string;
}

interface PluginUpdateNative {
    configurePluginUpdates?: (input: unknown) => Promise<{ enabled: boolean; channel: PluginUpdateChannel }>;
    getPluginUpdateStatus?: () => Promise<PluginUpdateStatus>;
    restartDiscord?: () => Promise<{ success: boolean; error?: string }>;
}

type PluginIpcExports = Omit<typeof import("./native"), "findLinuxNetnsLauncher">;
const Native = VencordNative?.pluginHelpers?.GoLiveBypass as unknown as (PluginNative<PluginIpcExports> & PluginUpdateNative) | undefined;

const logger = new Logger("GoLiveBypass");

interface RegionStore {
    getPreferredRegion(): string | null;
    getPreferredRegions(): string[] | null;
    shouldIncludePreferredRegion(): boolean;
}

interface VoiceRegion {
    id: string;
    name: string;
    optimal: boolean;
    deprecated: boolean;
    custom: boolean;
}

interface MediaEngineStore {
    supportsInApp(kind: string): boolean;
    supports(kind: string): boolean;
    isSupported(): boolean;
}

interface ApexExperiments {
    getServerAssignment(kind: string, unitId: string, name: string): unknown;
}

interface DiagnosticStore {
    [method: string]: unknown;
}

const RTCRegionStore: RegionStore = findStoreLazy("RTCRegionStore");
const MediaEngineStore: MediaEngineStore = findStoreLazy("MediaEngineStore");
const ApexExperimentStore: ApexExperiments & DiagnosticStore = findStoreLazy("ApexExperimentStore");
const ApplicationStreamingStore: DiagnosticStore = findStoreLazy("ApplicationStreamingStore");
const StreamRTCConnectionStore: DiagnosticStore = findStoreLazy("StreamRTCConnectionStore");
const RTCConnectionStore: DiagnosticStore = findStoreLazy("RTCConnectionStore");

const VIDEO_GUARD = "2026-08-video-guard";

const PLUGIN_VERSION = "2.0.13";
const PLUGIN_UPDATE_STATUS_POLL_INTERVAL_MS = 15_000;
const PLUGIN_UPDATE_STATUS_TIMEOUT_MS = 10_000;
const PLUGIN_UPDATE_CHECK_TIMEOUT_MS = 2 * 60_000 + 15_000;
const PLUGIN_UPDATE_INSTALL_TIMEOUT_MS = 3 * 60_000;
const CUSTOM_WIREGUARD_VALIDATION_TIMEOUT_MS = 30_000;
const PLUGIN_UPDATE_DEFER_MS = 6 * 60 * 60 * 1_000;

const AUTOMATIC = "";
const VOICE_KEYS: "voiceRegion"[] = ["voiceRegion"];
const STREAM_KEYS: "streamRegion"[] = ["streamRegion"];

let original: RegionStore | undefined;
let streamClaimTimer: ReturnType<typeof setInterval> | null = null;
let updateCheckTimer: ReturnType<typeof setTimeout> | null = null;
let lastNotifiedPendingVersion: string | null = null;
let lastNotifiedUpdateErrorKey: string | null = null;
let lastSuppressedUpdateErrorKey: string | null = null;
let streamClaimState: StreamClaimState = initialStreamClaimState();
let streamClaimStatus = "idle";
let streamClaimProbeFailed = false;
let lastStreamObservationKey: string | null = null;
let lastStreamObservation: {
    status: StreamObservationStatus;
    visibleStreamCount: number | null;
    nativeStreamCount: number | null;
} | null = null;
let lastSelectedStreamRegion: string | null = null;
let onboardingTimer: ReturnType<typeof setTimeout> | null = null;
let onboardingOpen = false;
let onboardingModalKey: string | null = null;
let onboardingModalToken = 0;
let pluginLifecycleGeneration = 0;
let pluginUpdateStatusFlight: Promise<PluginUpdateStatus> | null = null;
const pluginUpdateOverlayDismissers = new Set<() => void>();

function normalizedUpdateChannel(value: unknown): PluginUpdateChannel {
    return value === "beta" ? "beta" : "stable";
}

function pluginUpdateStatusMatchesPolicy(status: PluginUpdateStatus, policy: { enabled: boolean; channel: PluginUpdateChannel }): boolean {
    return status.enabled === policy.enabled && status.channel === policy.channel;
}

function pluginUpdateStatusMatchesRendererPolicy(status: PluginUpdateStatus): boolean {
    return pluginUpdateStatusMatchesPolicy(status, {
        enabled: settings.store.autoUpdate !== false,
        channel: normalizedUpdateChannel(settings.store.updateChannel),
    });
}

function withTimeout<T>(operation: () => Promise<T> | T, timeoutMs: number, timeoutMessage: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            reject(new Error(timeoutMessage));
        }, timeoutMs);
        const resolveOnce = (value: T) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(value);
        };
        const rejectOnce = (error: unknown) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            reject(error);
        };
        Promise.resolve().then(operation).then(resolveOnce, rejectOnce);
    });
}

function readPluginUpdateStatus(): Promise<PluginUpdateStatus> | null {
    const getStatus = Native?.getPluginUpdateStatus;
    if (typeof getStatus !== "function") return null;
    if (pluginUpdateStatusFlight) return pluginUpdateStatusFlight;

    const flight = withTimeout(
        () => getStatus(),
        PLUGIN_UPDATE_STATUS_TIMEOUT_MS,
        "The updater status check timed out.",
    );
    pluginUpdateStatusFlight = flight;
    void flight.finally(() => {
        if (pluginUpdateStatusFlight === flight) pluginUpdateStatusFlight = null;
    }).catch(() => undefined);
    return flight;
}

function dismissPluginUpdateOverlays(): void {
    for (const dismiss of pluginUpdateOverlayDismissers) dismiss();
}

function dismissPluginUpdateToast(version: string): void {
    // Permite que o polling do painel mostre novamente a mesma versão quando o
    // adiamento expirar; enquanto isso, updateDeferredUntil faz a supressão.
    lastNotifiedPendingVersion = null;
    settings.store.updateDeferredVersion = version;
    settings.store.updateDeferredUntil = String(Date.now() + PLUGIN_UPDATE_DEFER_MS);
}

function reloadForPreparedPluginUpdate(): void {
    const restart = Native?.restartDiscord;
    if (typeof restart !== "function") {
        showToast("Restart Discord manually to apply the GoLiveBypass update.", "failure");
        return;
    }
    void restart().then(result => {
        if (result?.success === false) {
            showToast(`GoLiveBypass couldn't restart Discord: ${result.error || "see the log"}`, "failure");
        }
    }).catch(error => {
        showToast(`GoLiveBypass couldn't restart Discord: ${error instanceof Error ? error.message : String(error)}`, "failure");
    });
}

function PluginUpdateToast({ currentVersion, availableVersion, channel, lifecycleGeneration }: { currentVersion: string; availableVersion: string; channel: PluginUpdateChannel; lifecycleGeneration: number }) {
    const [dismissed, setDismissed] = useState(false);
    const dismiss = React.useCallback(() => setDismissed(true), []);

    useEffect(() => {
        pluginUpdateOverlayDismissers.add(dismiss);
        return () => { pluginUpdateOverlayDismissers.delete(dismiss); };
    }, [dismiss]);

    if (dismissed || lifecycleGeneration !== pluginLifecycleGeneration) return null;

    return (
        <div
            role="status"
            aria-live="polite"
            onClick={event => event.stopPropagation()}
            style={{
                width: "min(360px, calc(100vw - 32px))",
                padding: "16px",
                borderRadius: "8px",
                background: "var(--background-floating)",
                border: "1px solid var(--background-modifier-accent)",
                boxShadow: "var(--elevation-high)",
            }}
        >
            <Paragraph><strong>GoLiveBypass update ready</strong></Paragraph>
            <Paragraph>Current: v{currentVersion} · available: v{availableVersion} · Channel: {channel}</Paragraph>
            <Paragraph>The update was downloaded, verified and prepared. Discord won't restart on its own.</Paragraph>
            <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end", flexWrap: "wrap" }}>
                <Button onClick={() => { dismiss(); dismissPluginUpdateToast(availableVersion); }}>Later</Button>
                <Button onClick={() => { dismiss(); reloadForPreparedPluginUpdate(); }}>Reload Discord</Button>
            </div>
        </div>
    );
}

function PluginUpdateFailureToast({ currentVersion, channel, error, lifecycleGeneration }: { currentVersion: string; channel: PluginUpdateChannel; error: string; lifecycleGeneration: number }) {
    const [dismissed, setDismissed] = useState(false);
    const dismiss = React.useCallback(() => setDismissed(true), []);

    useEffect(() => {
        pluginUpdateOverlayDismissers.add(dismiss);
        return () => { pluginUpdateOverlayDismissers.delete(dismiss); };
    }, [dismiss]);

    if (dismissed || lifecycleGeneration !== pluginLifecycleGeneration) return null;

    return (
        <div
            role="status"
            aria-live="polite"
            onClick={event => event.stopPropagation()}
            style={{
                width: "min(360px, calc(100vw - 32px))",
                padding: "16px",
                borderRadius: "8px",
                background: "var(--background-floating)",
                border: "1px solid var(--status-danger)",
                boxShadow: "var(--elevation-high)",
            }}
        >
            <Paragraph><strong>GoLiveBypass update failed</strong></Paragraph>
            <Paragraph>Current: v{currentVersion} · Channel: {channel}</Paragraph>
            <Paragraph>{error.slice(0, 240)}</Paragraph>
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
                <Button onClick={dismiss}>Later</Button>
            </div>
        </div>
    );
}

interface PluginUpdateErrorContext {
    key: string;
    currentVersion: string;
    channel: PluginUpdateChannel;
    detail: string;
}

function pluginUpdateErrorContext(current: unknown, channel: unknown, error: unknown): PluginUpdateErrorContext | null {
    if (typeof error !== "string" || !error.trim()) return null;
    const currentVersion = typeof current === "string" && current ? current : PLUGIN_VERSION;
    const normalizedChannel = normalizedUpdateChannel(channel);
    const detail = error.trim().slice(0, 240);
    return { key: `${normalizedChannel}:${currentVersion}:${detail}`, currentVersion, channel: normalizedChannel, detail };
}

function suppressPluginUpdateFailure(current: unknown, channel: unknown, error: unknown): void {
    const context = pluginUpdateErrorContext(current, channel, error);
    if (context) lastSuppressedUpdateErrorKey = context.key;
}

function notifyPluginUpdateFailure(current: unknown, channel: unknown, error: unknown): void {
    const context = pluginUpdateErrorContext(current, channel, error);
    if (!context) return;
    if (context.key === lastSuppressedUpdateErrorKey) {
        lastSuppressedUpdateErrorKey = null;
        return;
    }
    lastSuppressedUpdateErrorKey = null;
    if (context.key === lastNotifiedUpdateErrorKey) return;
    lastNotifiedUpdateErrorKey = context.key;
    showToast("GoLiveBypass update", "custom", {
        position: 1 /* Discord ToastPosition.BOTTOM */,
        duration: 15_000,
        component: <PluginUpdateFailureToast currentVersion={context.currentVersion} channel={context.channel} error={context.detail} lifecycleGeneration={pluginLifecycleGeneration} />,
    });
}

function notifyPendingPluginUpdate(current: unknown, version: unknown, channel: unknown): void {
    if (typeof version !== "string" || !version || version === lastNotifiedPendingVersion) return;
    const currentVersion = typeof current === "string" && current ? current : PLUGIN_VERSION;
    const normalizedChannel = normalizedUpdateChannel(channel);
    const deferredVersion = settings.store.updateDeferredVersion;
    const deferredUntil = Number(settings.store.updateDeferredUntil);
    if (deferredVersion === version && Number.isFinite(deferredUntil) && deferredUntil > Date.now()) return;
    lastNotifiedPendingVersion = version;
    showToast("GoLiveBypass update", "custom", {
        position: 1 /* Discord ToastPosition.BOTTOM */,
        duration: 15_000,
        component: <PluginUpdateToast currentVersion={currentVersion} availableVersion={version} channel={normalizedChannel} lifecycleGeneration={pluginLifecycleGeneration} />,
    });
}

function schedulePluginUpdateStatusObservation(lifecycleGeneration: number): void {
    if (updateCheckTimer !== null) clearTimeout(updateCheckTimer);

    const observe = () => {
        updateCheckTimer = null;
        if (lifecycleGeneration !== pluginLifecycleGeneration) return;
        const scheduleNext = () => {
            if (lifecycleGeneration !== pluginLifecycleGeneration) return;
            updateCheckTimer = setTimeout(observe, PLUGIN_UPDATE_STATUS_POLL_INTERVAL_MS);
        };
        const statusRequest = readPluginUpdateStatus();
        if (!statusRequest) {
            scheduleNext();
            return;
        }
        statusRequest.then(status => {
            if (lifecycleGeneration !== pluginLifecycleGeneration) return;
            if (!pluginUpdateStatusMatchesRendererPolicy(status)) return;
            if (status.lastError) notifyPluginUpdateFailure(status.current, status.channel, status.lastError);
            else {
                lastNotifiedUpdateErrorKey = null;
                lastSuppressedUpdateErrorKey = null;
            }
            if (status.pending) notifyPendingPluginUpdate(status.current, status.pendingVersion, status.pendingChannel || status.channel);
        }).catch(error => {
            if (lifecycleGeneration === pluginLifecycleGeneration) recordRendererError("Falha ao consultar atualização pendente do plugin", error);
        }).finally(scheduleNext);
    };

    updateCheckTimer = setTimeout(observe, 8_000);
}

interface RegionSelectProps {
    value: string;
    placeholder: string;
    automaticLabel: string;
    onChange(region: string): void;
}

function RegionSelect({ value, placeholder, automaticLabel, onChange }: RegionSelectProps) {
    const [regions, error, pending] = useAwaiter(
        async () => {
            const { body } = await RestAPI.get({ url: Constants.Endpoints.REGIONS() });
            return (body as VoiceRegion[]).filter(region => !region.deprecated && !region.custom);
        },
        { fallbackValue: [] as VoiceRegion[] }
    );

    if (pending) return <Paragraph>Loading the region list.</Paragraph>;
    if (error) return <Paragraph>Discord did not hand over the region list. Log in and reopen settings to try again.</Paragraph>;

    const options = [
        { label: automaticLabel, value: AUTOMATIC },
        ...regions.map(region => ({ label: region.optimal ? `${region.name}, optimal for you` : region.name, value: region.id }))
    ];

    return (
        <SearchableSelect
            placeholder={placeholder}
            maxVisibleItems={8}
            options={options}
            value={options.find(option => option.value === value)?.value}
            onChange={onChange}
            closeOnSelect
        />
    );
}

function VoiceRegionPicker() {
    const { voiceRegion } = settings.use(VOICE_KEYS);

    return (
        <RegionSelect
            value={voiceRegion}
            placeholder="Pick the region your calls should connect through"
            automaticLabel="Automatic, whatever Discord picks"
            onChange={region => settings.store.voiceRegion = region}
        />
    );
}

function StreamRegionPicker() {
    const { streamRegion } = settings.use(STREAM_KEYS);

    return (
        <RegionSelect
            value={streamRegion}
            placeholder="Pick the region your screen share should go through"
            automaticLabel="Same region as your call"
            onChange={region => settings.store.streamRegion = region}
        />
    );
}

interface ProtonSessionCheck {
    valid: boolean;
    username?: string;
    expiresIn?: string;
    code?: "INVALID_SESSION" | "NETWORK_ERROR" | "TIMEOUT" | "MISSING_EXECUTABLE" | "SESSION_PERSISTENCE" | "UNKNOWN";
    error?: string;
}

interface PluginOptimizationStatus {
    active: boolean;
    requestId: string | null;
    phase: "ping" | "preparing" | "testing" | "finalizing" | "completed" | "failed" | "cancelled" | null;
    total: number;
    tested: number;
    succeeded: number;
    server?: string;
    pingMs?: number;
    downloadMbps?: number;
    uploadMbps?: number;
    error?: string;
    updatedAt: number | null;
}

function protonSessionStatusTitle(code: ProtonSessionCheck["code"]): string {
    switch (code) {
        case "NETWORK_ERROR":
        case "TIMEOUT":
            return "No network to check the session";
        case "MISSING_EXECUTABLE":
            return "ProtonVPN component missing";
        case "SESSION_PERSISTENCE":
            return "Session storage unavailable";
        case "INVALID_SESSION":
            return "Session needs to be renewed";
        default:
            return "Couldn't check the session";
    }
}

type OnboardingPage = "account" | "route" | "ready";

const onboardingBoxStyle = {
    background: "var(--background-secondary-alt)",
    border: "1px solid var(--background-modifier-accent)",
    borderRadius: "8px",
    padding: "16px",
};

interface PluginRouteDiscoverySnapshot {
    active: boolean;
    requestId: string | null;
    measurementId: string | null;
    phase: ProtonRouteProgressPhase | null;
    routes: ProtonRouteCatalogEntry[];
    error?: string;
    updatedAt: number | null;
    contextMatches?: boolean;
}

interface PluginRouteDiscoveryResult {
    success: boolean;
    measurementId?: string;
    routes?: ProtonRouteCatalogEntry[];
    error?: string;
    cancelled?: boolean;
}

interface PluginRouteSelectionResult {
    success: boolean;
    server?: string;
    error?: string;
    cancelled?: boolean;
}

interface ProtonRouteDiscoveryState {
    active: boolean;
    phase: ProtonRouteProgressPhase | null;
    error: string | null;
}

interface ProtonRouteOptimizationView {
    active: boolean;
    label: string;
    error?: string | null;
    progress?: PluginOptimizationStatus | null;
}

interface ProtonRouteSelectionProps {
    routes: readonly ProtonRouteCandidate[];
    recommendedServer?: string;
    discovery: ProtonRouteDiscoveryState;
    optimization: ProtonRouteOptimizationView;
    applyingServer: string | null;
    selectionError?: string | null;
    /** Sessão inválida: a lista não consulta o catálogo e orienta a recuperação. */
    lockedReason?: string | null;
    emptyMessage: string;
    /** Rota do perfil ativo (sobrevive ao catálogo): o túnel já pode estar valendo sem lista carregada. */
    activeRoute?: VpnRouteInfo | null;
    /** `true` quando o túnel está ativo agora; `false` mostra a rota como preparada. */
    routeActive?: boolean;
    onOptimize(): void;
    onDiscover(): void;
    onSelect(server: string): void;
    onCancelSelection(): void;
}

const PROTON_ROUTE_DISCOVERY_POLL_INTERVAL_MS = 750;

const protonRouteListStyle = {
    listStyle: "none",
    margin: 0,
    padding: 0,
    maxHeight: "min(32vh, 240px)",
    overflowY: "auto" as const,
    border: "1px solid var(--background-modifier-accent)",
    borderRadius: "8px",
};

const protonRouteRowStyle = {
    display: "flex",
    flexDirection: "column" as const,
    gap: "4px",
    padding: "10px 12px",
    borderBottom: "1px solid var(--background-modifier-accent)",
};

const protonRouteRowTopStyle = {
    display: "flex",
    justifyContent: "space-between",
    gap: "8px",
    flexWrap: "wrap" as const,
    alignItems: "baseline",
};

const protonRouteMetaStyle = { color: "var(--text-muted)", fontSize: "12px" };

const protonRouteBadgeStyle = {
    marginLeft: "8px",
    padding: "2px 6px",
    borderRadius: "4px",
    background: "var(--brand-experiment-560)",
    color: "var(--white-500)",
    fontSize: "11px",
    fontWeight: 600,
};

/**
 * Sessão de descoberta compartilhada pelo assistente e pelo painel. O renderer
 * nunca fala com o helper: inicia a descoberta, observa o snapshot nativo (que
 * sobrevive a remount) e aplica a rota escolhida somente com o identificador da
 * medição e o nome exato do servidor.
 */
const PANEL_CACHE_MS = 10 * 60_000;

function isRecentRouteMeasurement(snapshot: PluginRouteDiscoverySnapshot) {
    return snapshot.active !== true
        && snapshot.contextMatches !== false
        && !snapshot.error
        && Array.isArray(snapshot.routes) && snapshot.routes.length > 0
        && typeof snapshot.updatedAt === "number"
        && Date.now() - snapshot.updatedAt < PANEL_CACHE_MS;
}

function useProtonRouteSelection({ active, account, country, freeOnly, autoPing }: {
    active: boolean;
    account: string;
    country: string;
    freeOnly: boolean;
    autoPing: boolean;
}) {
    const [candidates, setCandidates] = useState<Map<string, ProtonRouteCandidate>>(() => new Map());
    const [discovery, setDiscovery] = useState<ProtonRouteDiscoveryState>({ active: false, phase: null, error: null });
    const [applyingServer, setApplyingServer] = useState<string | null>(null);
    const [selectionError, setSelectionError] = useState<string | null>(null);
    const [appliedServer, setAppliedServer] = useState<string | null>(null);
    const [revision, setRevision] = useState(0);
    const measurementIdRef = React.useRef<string | null>(null);
    const requestRef = React.useRef<string | null>(null);
    const statusSignatureRef = React.useRef("");
    const applyingRef = React.useRef(false);
    const mountedRef = React.useRef(true);
    // A conta e os filtros fazem parte da chave: trocar qualquer um deles
    // invalida a medição anterior em vez de aplicar uma rota de outro contexto.
    const filtersKey = `${account}|${country}|${freeOnly ? "free" : "all"}|${autoPing ? "ping" : "noping"}`;
    const filtersKeyRef = React.useRef(filtersKey);

    React.useEffect(() => {
        mountedRef.current = true;
        return () => { mountedRef.current = false; };
    }, []);

    const applySnapshot = React.useCallback((snapshot: PluginRouteDiscoverySnapshot | null) => {
        if (!snapshot) return;
        const compatible = snapshot.contextMatches !== false;
        const incomingMeasurementId = compatible ? snapshot.measurementId ?? null : null;
        const routes = incomingMeasurementId && Array.isArray(snapshot.routes) ? snapshot.routes : [];
        const measurementChanged = incomingMeasurementId !== measurementIdRef.current;
        const signature = `${incomingMeasurementId ?? ""}|${snapshot.active === true}|${snapshot.phase ?? ""}|${snapshot.error ?? ""}|${snapshot.updatedAt ?? 0}|${routes.length}`;
        measurementIdRef.current = incomingMeasurementId;
        if (signature === statusSignatureRef.current) return;
        statusSignatureRef.current = signature;
        setCandidates(current => mergeProtonRouteCatalog(measurementChanged ? new Map() : current, routes));
        if (measurementChanged) setAppliedServer(null);
        setDiscovery({
            active: compatible && snapshot.active === true,
            phase: compatible ? snapshot.phase ?? null : null,
            error: compatible && snapshot.error ? safeDiagnosticDetail(snapshot.error, 240) : null,
        });
    }, []);

    const readSnapshot = React.useCallback(async (): Promise<PluginRouteDiscoverySnapshot | null> => {
        const read = Native?.getProtonRouteDiscoveryStatus;
        if (typeof read !== "function") return null;
        try {
            const snapshot = await read({ username: account, country, freeOnly, autoPing }) as PluginRouteDiscoverySnapshot;
            if (!mountedRef.current || filtersKeyRef.current !== filtersKey) return null;
            return snapshot;
        } catch (error) {
            recordRendererError("Falha ao consultar a descoberta de rotas Proton", error);
            return null;
        }
    }, [account, country, freeOnly, autoPing, filtersKey]);

    React.useEffect(() => {
        const previousRequestId = requestRef.current;
        requestRef.current = null;
        // O catálogo pertence ao contexto (conta|país|freeOnly|autoPing): só uma
        // mudança real dele invalida as rotas medidas. `active=false` (sessão
        // inválida ou verificação temporariamente indisponível) derruba apenas a
        // requisição em voo — esconder a lista foi o relato "sumiu a seleção
        // manual": o usuário fica sem nenhuma saída visual.
        const contextChanged = filtersKeyRef.current !== filtersKey;
        filtersKeyRef.current = filtersKey;
        if (contextChanged) {
            measurementIdRef.current = null;
            statusSignatureRef.current = "";
            setCandidates(new Map());
            setAppliedServer(null);
        }
        setSelectionError(null);
        if (previousRequestId && typeof Native?.cancelProtonRouteDiscovery === "function") {
            void Promise.resolve(Native.cancelProtonRouteDiscovery(previousRequestId))
                .catch(error => recordRendererError("Falha ao cancelar a descoberta anterior de rotas Proton", error));
        }
        if (!active || !Native || typeof Native.discoverProtonRoutes !== "function") {
            setDiscovery({ active: false, phase: null, error: null });
            return;
        }

        let disposed = false;
        let timer: ReturnType<typeof setInterval> | null = null;
        const stopTimer = () => {
            if (timer === null) return;
            clearInterval(timer);
            timer = null;
        };
        const poll = async () => {
            const snapshot = await readSnapshot();
            if (disposed || !snapshot) return;
            // Evento de outra geração: descarta sem tocar na lista atual.
            if (snapshot.requestId && requestRef.current && snapshot.requestId !== requestRef.current) return;
            applySnapshot(snapshot);
            if (!snapshot.active) stopTimer();
        };

        const start = async () => {
            const snapshot = await readSnapshot();
            if (disposed) return;
            if (snapshot?.active && snapshot.contextMatches !== false) {
                // Remount com descoberta em andamento: adota a sessão nativa em
                // vez de abrir uma segunda e perder o progresso já recebido.
                applySnapshot(snapshot);
                requestRef.current = snapshot.requestId ?? null;
                timer = setInterval(() => void poll(), PROTON_ROUTE_DISCOVERY_POLL_INTERVAL_MS);
                return;
            }
            if (snapshot) applySnapshot(snapshot);
            // Abrir o painel não mede tudo de novo: "Find routes" e "Try again" mudam `revision`.
            if (revision === 0 && snapshot && isRecentRouteMeasurement(snapshot)) return;
            if (snapshot?.active && snapshot.contextMatches === false && typeof Native.cancelProtonRouteDiscovery === "function") {
                await Native.cancelProtonRouteDiscovery(snapshot.requestId ?? undefined);
                if (disposed) return;
            }
            const requestId = `plugin-route-catalog-${Date.now()}-${Math.random().toString(16).slice(2)}`;
            requestRef.current = requestId;
            setDiscovery({ active: true, phase: "catalog", error: null });
            timer = setInterval(() => void poll(), PROTON_ROUTE_DISCOVERY_POLL_INTERVAL_MS);
            let keepPolling = false;
            try {
                const result = await Native.discoverProtonRoutes({ requestId, country, freeOnly, autoPing }) as PluginRouteDiscoveryResult;
                if (disposed) return;
                const failed = result?.success !== true;
                const completed = {
                    active: false,
                    phase: result?.cancelled ? "cancelled" as const : failed ? "failed" as const : "completed" as const,
                    error: failed ? safeDiagnosticDetail(result?.error || "Couldn't list the Proton routes.", 240) : null,
                };
                if (result?.measurementId) {
                    const current = await readSnapshot();
                    if (disposed) return;
                    // O resultado pode chegar antes do primeiro polling: usa a
                    // mesma troca de geração. Se outro componente já substituiu
                    // a operação, o snapshot atual prevalece sobre o retorno.
                    applySnapshot(current ?? {
                        ...completed,
                        error: completed.error ?? undefined,
                        requestId,
                        measurementId: result.measurementId,
                        routes: Array.isArray(result.routes) ? result.routes : [],
                        updatedAt: Date.now(),
                        contextMatches: true,
                    });
                    if (current?.active && current.contextMatches !== false) {
                        requestRef.current = current.requestId;
                        keepPolling = true;
                    }
                } else setDiscovery(completed);
            } catch (error) {
                if (!disposed) {
                    setDiscovery({ active: false, phase: "failed", error: safeDiagnosticDetail(error || "Couldn't list the Proton routes.", 240) });
                }
            } finally {
                if (!keepPolling) stopTimer();
            }
        };

        void start().catch(error => {
            if (!disposed) setDiscovery({ active: false, phase: "failed", error: safeDiagnosticDetail(error, 240) });
        });
        return () => {
            disposed = true;
            stopTimer();
        };
    }, [active, filtersKey, revision, applySnapshot, readSnapshot]);

    const restart = React.useCallback(() => setRevision(value => value + 1), []);

    const refresh = React.useCallback(async () => {
        applySnapshot(await readSnapshot());
    }, [applySnapshot, readSnapshot]);

    const select = React.useCallback((server: string) => {
        const native = Native;
        const measurementId = measurementIdRef.current;
        if (!native || typeof native.selectProtonRoute !== "function") {
            setSelectionError("This plugin build doesn't support manual route selection. Update or reinstall it.");
            return;
        }
        if (!measurementId) {
            setSelectionError("Route measurements aren't available yet. Find routes again.");
            return;
        }
        if (applyingRef.current) return;
        applyingRef.current = true;
        setSelectionError(null);
        setApplyingServer(server);
        void Promise.resolve(native.selectProtonRoute({ measurementId, server })).then(result => {
            const answer = result as PluginRouteSelectionResult;
            if (!mountedRef.current) return;
            if (answer?.success === true) {
                setAppliedServer(answer.server || server);
                return;
            }
            setSelectionError(safeDiagnosticDetail(answer?.error || "Couldn't apply this Proton route. Pick another one or run Optimize.", 240));
        }).catch(error => {
            if (mountedRef.current) setSelectionError(safeDiagnosticDetail(error, 240));
        }).finally(() => {
            applyingRef.current = false;
            if (mountedRef.current) setApplyingServer(null);
        });
    }, []);

    const cancelSelection = React.useCallback(() => {
        const cancel = Native?.cancelProtonRouteSelection;
        if (typeof cancel !== "function") return;
        void Promise.resolve(cancel()).catch(error => recordRendererError("Falha ao cancelar a aplicação da rota Proton", error));
    }, []);

    const routes = React.useMemo(() => [...candidates.values()], [candidates]);
    const recommendedServer = React.useMemo(() => recommendProtonRoute(candidates.values()), [candidates]);
    // Saída para a falha da otimização automática: sem rota já medida e
    // selecionável, o catálogo é medido de novo para a lista manual aparecer
    // ordenada por ping. Com rota utilizável na lista, nada é refeito.
    const measureCatalogIfEmpty = React.useCallback(() => {
        if (!active) return;
        if (!shouldMeasureRouteCatalogOnFailure(routes)) return;
        restart();
    }, [active, routes, restart]);

    return {
        routes,
        recommendedServer,
        discovery,
        applyingServer,
        selectionError,
        appliedServer,
        select,
        cancelSelection,
        restart,
        refresh,
        measureCatalogIfEmpty,
    };
}

/** Seção compartilhada pelo assistente e pelo painel. Não chama o helper. */
function ProtonRouteSelection({
    routes,
    recommendedServer,
    discovery,
    optimization,
    applyingServer,
    selectionError,
    lockedReason,
    emptyMessage,
    activeRoute,
    routeActive,
    onOptimize,
    onDiscover,
    onSelect,
    onCancelSelection,
}: ProtonRouteSelectionProps) {
    const ordered = React.useMemo(() => sortProtonRouteCandidates(routes), [routes]);
    const measuredCount = ordered.filter(isProtonRouteSelectable).length;
    const exclusive = optimization.active || discovery.active || applyingServer !== null;
    const progress = optimization.progress ?? null;
    const progressPercent = progress && progress.total > 0
        ? Math.min(100, Math.round((progress.tested / progress.total) * 100))
        : null;
    const progressIsIndeterminate = optimization.active && progressPercent === null;
    const activeRouteSummary = formatVpnRouteSummary(activeRoute ?? null);
    const heading = ordered.length > 0
        ? `Choose a Proton route: ${measuredCount} of ${ordered.length} routes with ping`
        : "Choose a Proton route";
    const routeList = (
        <ul aria-label="Available Proton routes" tabIndex={0} style={protonRouteListStyle}>
            {ordered.map(candidate => {
                const selectable = isProtonRouteSelectable(candidate);
                const stateLabel = protonRouteStateLabel(candidate, { discoveryActive: discovery.active });
                const applying = applyingServer === candidate.server;
                const location = protonRouteLocation(candidate);
                const tier = protonRouteTierLabel(candidate);
                return (
                    <li key={candidate.server} style={protonRouteRowStyle}>
                        <div style={protonRouteRowTopStyle}>
                            <span>
                                <strong>{candidate.server}</strong>
                                {candidate.server === recommendedServer && <span style={protonRouteBadgeStyle}>Recommended</span>}
                            </span>
                            <span>{formatProtonRoutePing(candidate.pingMs)}</span>
                        </div>
                        {location && <span style={protonRouteMetaStyle}>{location}</span>}
                        {tier && <span style={protonRouteMetaStyle}>{tier}</span>}
                        <div style={protonRouteRowTopStyle}>
                            <span style={protonRouteMetaStyle}>{applying ? `Applying route ${candidate.server}…` : stateLabel}</span>
                            <Button
                                onClick={() => applying ? onCancelSelection() : onSelect(candidate.server)}
                                disabled={applying ? false : (!selectable || exclusive || Boolean(lockedReason))}
                                aria-label={applying ? `Cancel applying route ${candidate.server}` : `Select route ${candidate.server}`}
                                title={applying ? "Cancel applying" : (selectable ? undefined : (stateLabel || "Route unavailable"))}
                            >
                                {applying ? "Cancel" : "Select route"}
                            </Button>
                        </div>
                    </li>
                );
            })}
        </ul>
    );

    return (
        <section aria-label="Manual Proton route selection" style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            <div>
                <Button onClick={onOptimize} disabled={exclusive || Boolean(lockedReason)}>
                    {optimization.active ? "Optimizing automatically…" : "Optimize automatically"}
                </Button>
            </div>
            <div style={onboardingBoxStyle} role="status" aria-live="polite" aria-busy={optimization.active}>
                <div style={protonRouteRowTopStyle}>
                    <strong>Route state</strong>
                    <span>{optimization.label}</span>
                </div>
                {(progressPercent !== null || progressIsIndeterminate) && (
                    <progress
                        {...(progressPercent === null ? {} : { value: progressPercent })}
                        max={100}
                        aria-label="Automatic optimization progress"
                        aria-valuetext={progressPercent === null ? "Optimization running; total not known yet" : `${progressPercent}%`}
                        style={{ width: "100%", marginTop: "12px" }}
                    />
                )}
                {progress && progress.total > 0 && <Paragraph>{progress.tested} of {progress.total} servers tested · {progress.succeeded} passed</Paragraph>}
                {progress?.server && <Paragraph>Selected server: {progress.server}</Paragraph>}
                {typeof progress?.pingMs === "number" && <Paragraph>Measured latency: {progress.pingMs} ms</Paragraph>}
                {activeRouteSummary && (
                    <div style={protonRouteRowTopStyle}>
                        <span>{routeActive ? "Route in use now" : "Route ready in the profile"}</span>
                        <strong>{activeRouteSummary}</strong>
                    </div>
                )}
            </div>
            {optimization.error && (
                <Paragraph role="alert" aria-live="assertive">
                    <strong>{optimization.error}</strong> Manual selection is still available in the list below, sorted by ping.
                </Paragraph>
            )}
            <Paragraph><strong>{heading}</strong></Paragraph>
            {discovery.active && (
                <Paragraph role="status" aria-live="polite">
                    Proton catalog updating: routes already measured show in the list and can be selected again when measuring ends.
                </Paragraph>
            )}
            {lockedReason ? (
                <>
                    <Paragraph role="status" aria-live="polite">{lockedReason}</Paragraph>
                    {/* Sessão travada não apaga o catálogo: a lista medida da mesma
                        conta continua visível (com os controles desabilitados pela
                        trava) para o usuário ver onde está e o que vai voltar a
                        funcionar quando a sessão for revalidada. */}
                    {ordered.length > 0 && routeList}
                </>
            ) : (
                <>
                    {discovery.error && (
                        <Paragraph role="alert" aria-live="assertive">
                            <strong>{discovery.error}</strong>{" "}
                            <Button onClick={onDiscover} disabled={exclusive}>Find routes again</Button>
                        </Paragraph>
                    )}
                    {ordered.length === 0 ? (
                        // Enquanto o catálogo é medido, "nenhuma rota catalogada" seria
                        // falso: o aviso de atualização acima já descreve o estado.
                        discovery.active ? null : (
                            <Paragraph role="status" aria-live="polite">
                                {routeActive && activeRouteSummary
                                    ? <>The tunnel is on with <strong>{activeRouteSummary}</strong>. The list for this session hasn't loaded yet. Use "Find routes again" or "Optimize automatically" to measure other routes.</>
                                    : emptyMessage}
                            </Paragraph>
                        )
                    ) : routeList}
                </>
            )}
            {selectionError && <Paragraph role="alert" aria-live="assertive"><strong>{selectionError}</strong></Paragraph>}
        </section>
    );
}

function OnboardingSteps({ page, customMode }: { page: OnboardingPage; customMode: boolean }) {
    const active = page === "account" ? 0 : page === "route" ? 1 : 2;
    const labels = customMode
        ? ["1  WireGuard config", "2  Real route", "3  Done"]
        : ["1  Proton account", "2  Real route", "3  Done"];
    return (
        <div style={{ display: "flex", flexWrap: "wrap", gap: "8px", marginBottom: "16px" }} aria-label="Setup steps" role="list">
            {labels.map((label, index) => (
                <div
                    key={label}
                    role="listitem"
                    aria-current={index === active ? "step" : undefined}
                    style={{
                        flex: "1 1 120px",
                        minWidth: 0,
                        padding: "8px 10px",
                        borderRadius: "6px",
                        background: index <= active ? "var(--brand-experiment-560)" : "var(--background-tertiary)",
                        color: index <= active ? "var(--white-500)" : "var(--text-muted)",
                        fontSize: "12px",
                        fontWeight: 600,
                        textAlign: "center",
                    }}
                >
                    {label}
                </div>
            ))}
        </div>
    );
}

function PluginOnboardingModal({ modalProps, onClosed }: { modalProps: RenderModalProps; onClosed: () => void }) {
    const { protonCountry, protonFreeOnly, protonAutoPing, vpnMode } = settings.use(["vpnMode", "protonCountry", "protonFreeOnly", "protonAutoPing"]);
    // Inscrito em `vpnMode`: trocar de modo no meio do assistente re-renderiza a
    // página de conta com o fluxo escolhido, sem fechar nem perder o progresso.
    const customMode = vpnMode === "custom";
    const requiredOnOpen = Boolean(Native && settings.store.onboardingCompleted !== true);
    const [page, setPage] = useState<OnboardingPage>("account");
    const [username, setUsername] = useState("");
    const [password, setPassword] = useState("");
    const [twoFactorCode, setTwoFactorCode] = useState("");
    const [session, setSession] = useState<ProtonSessionCheck | null>(null);
    const [sessionLoading, setSessionLoading] = useState(true);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [customConfigPath, setCustomConfigPath] = useState(
        typeof settings.store.customConfigPath === "string" ? settings.store.customConfigPath : ""
    );
    const [vpnStatus, setVpnStatus] = useState<PluginVpnStatus | null>(null);
    const [optimization, setOptimization] = useState<PluginOptimizationStatus | null>(null);
    const [requestId, setRequestId] = useState<string | null>(null);
    const disposedRef = React.useRef(false);
    const accountRevisionRef = React.useRef(0);
    const sessionCheckRef = React.useRef(0);
    const closedRef = React.useRef(false);
    const pageHeadingRef = React.useRef<HTMLHeadingElement | null>(null);
    const loginRequestIdRef = React.useRef<string | null>(null);
    const optimizationRequestRef = React.useRef<string | null>(null);
    const optimizationAttemptRef = React.useRef(0);
    const optimizationStatusRequestRef = React.useRef(0);
    const requireFreshOptimizationRef = React.useRef(false);
    const passwordRef = React.useRef<HTMLInputElement | null>(null);
    const [loginCancelRequested, setLoginCancelRequested] = useState(false);
    // A rota manual só existe com sessão Proton validada: sem ela a lista nem
    // consulta o catálogo e a etapa de conta orienta a recuperação.
    const routeSelectionActive = page === "route" && !customMode && session?.valid === true;
    const routeSelection = useProtonRouteSelection({
        active: routeSelectionActive,
        account: username,
        country: protonCountry,
        freeOnly: protonFreeOnly !== false,
        autoPing: protonAutoPing !== false,
    });
    const manualRouteServer = routeSelection.appliedServer;
    // Qual caminho escreveu o perfil por último: a tela final precisa nomear a
    // rota certa em vez de mostrar as duas.
    const [routeSource, setRouteSource] = useState<"automatic" | "manual" | null>(null);
    useEffect(() => {
        if (routeSelection.appliedServer) setRouteSource("manual");
    }, [routeSelection.appliedServer]);

    const cancelActiveOptimization = () => {
        optimizationAttemptRef.current++;
        optimizationStatusRequestRef.current++;
        const activeRequestId = optimizationRequestRef.current;
        optimizationRequestRef.current = null;
        if (!activeRequestId || typeof Native?.cancelProtonOptimization !== "function") return;
        void Promise.resolve(Native.cancelProtonOptimization(activeRequestId)).catch(error => recordRendererError("Falha ao cancelar otimização ao fechar o assistente", error));
    };

    const cancelActiveLogin = () => {
        const activeRequestId = loginRequestIdRef.current;
        if (!activeRequestId || typeof Native?.cancelProtonLogin !== "function") return;
        loginRequestIdRef.current = null;
        accountRevisionRef.current++;
        sessionCheckRef.current++;
        setPassword("");
        setTwoFactorCode("");
        if (!disposedRef.current) {
            setLoginCancelRequested(true);
            setError("Cancelling Proton sign-in…");
        }
        void Promise.resolve(Native.cancelProtonLogin(activeRequestId)).catch(error => recordRendererError("Falha ao cancelar login Proton", error));
    };

    useEffect(() => {
        disposedRef.current = false;
        return () => {
            disposedRef.current = true;
            accountRevisionRef.current++;
            sessionCheckRef.current++;
            cancelActiveLogin();
            cancelActiveOptimization();
            onClosed();
        };
    }, []);
    useEffect(() => {
        let active = true;
        if (typeof Native?.getVpnStatus === "function") {
            void Promise.resolve(Native.getVpnStatus()).then(status => {
                if (active && !disposedRef.current && status) setVpnStatus(status as PluginVpnStatus);
            }).catch(() => {});
        }
        return () => { active = false; };
    }, []);

    useEffect(() => {
        if (!disposedRef.current) {
            const timer = setTimeout(() => {
                if (!disposedRef.current) pageHeadingRef.current?.focus({ preventScroll: true });
            }, 50);
            return () => clearTimeout(timer);
        }
    }, [page]);

    const closeModal = () => {
        if (closedRef.current) return;
        // Fechar sem concluir é um skip explícito e persistente: o assistente não
        // reabre sozinho (o X não trava mais o usuário — #334), o painel e o
        // updater continuam acessíveis e dá para configurar depois pela toolbox.
        // Sem ponte nativa não há estado a gravar.
        if (requiredOnOpen && settings.store.onboardingCompleted !== true) settings.store.onboardingSkipped = true;
        closedRef.current = true;
        if (page === "account" && busy) cancelActiveLogin();
        if (page === "route" && busy) cancelActiveOptimization();
        disposedRef.current = true;
        accountRevisionRef.current++;
        sessionCheckRef.current++;
        onClosed();
        modalProps.onClose();
    };

    const complete = () => {
        settings.store.onboardingCompleted = true;
        settings.store.onboardingSkipped = false;
        closeModal();
        if (typeof Native?.enable !== "function") return;
        // Concluir a configuração precisa deixar o Discord já roteado, sem um passo manual no
        // painel. "Voltar" continua disponível para quem quiser reconfigurar.
        const activate = async (): Promise<{ success: boolean; error?: string; message?: string; }> => {
            const goLive = await turnOnGoLive();
            if (goLive === null) return Native!.enable();
            return { success: goLive.state === "active", error: goLive.error ?? undefined };
        };
        void activate().then(result => {
            if (result.success === false) {
                showToast(
                    `GoLiveBypass couldn't turn on the VPN: ${result.error || result.message || "see the log"}`,
                    "failure"
                );
            }
        }).catch(activationError => {
            recordRendererError("Falha ao ativar a VPN após concluir a configuração", activationError);
        });
    };

    const checkSession = async (value: string) => {
        if (!Native || !value.trim()) {
            if (!disposedRef.current) setSession({ valid: false, code: "INVALID_SESSION", error: "Enter the Proton username." });
            return null;
        }
        const revision = accountRevisionRef.current;
        const request = ++sessionCheckRef.current;
        const isCurrent = () => !disposedRef.current
            && revision === accountRevisionRef.current
            && request === sessionCheckRef.current;
        setSessionLoading(true);
        try {
            const result = await Native.checkProtonSession(value.trim()) as ProtonSessionCheck;
            if (!isCurrent()) return null;
            setSession(result);
            return result;
        } catch {
            if (!isCurrent()) return null;
            const result: ProtonSessionCheck = {
                valid: false,
                code: "NETWORK_ERROR",
                error: "Couldn't check the Proton session because of the network.",
            };
            setSession(result);
            return result;
        } finally {
            if (isCurrent()) setSessionLoading(false);
        }
    };

    useEffect(() => {
        let disposed = false;
        const loadRevision = accountRevisionRef.current;
        const load = async () => {
            if (!Native) {
                if (!disposed) setSessionLoading(false);
                return;
            }
            if (customMode) {
                if (!disposed && !disposedRef.current) {
                    setSession(null);
                    setSessionLoading(false);
                }
                return;
            }
            try {
                const saved = await Native.getProtonSettings();
                const record = saved as { protonUsername?: unknown; sessionUsername?: unknown };
                const savedUsername = typeof record.sessionUsername === "string" && record.sessionUsername.trim()
                    ? record.sessionUsername.trim()
                    : typeof record.protonUsername === "string" ? record.protonUsername.trim() : "";
                if (disposed || disposedRef.current || loadRevision !== accountRevisionRef.current) return;
                if (savedUsername) {
                    setUsername(savedUsername);
                    const result = await checkSession(savedUsername);
                    if (!disposed && !disposedRef.current && result?.valid) {
                        setError(null);
                        // A sessão salva já vale: pedir email e senha de novo é
                        // atrito puro. Vai direto para a rota, que é o passo que
                        // falta; "Voltar" reabre a conta para quem quiser trocar.
                        enterRoute();
                    }
                } else {
                    setSessionLoading(false);
                }
            } catch (loadError) {
                if (!disposed && !disposedRef.current && loadRevision === accountRevisionRef.current) {
                    setSessionLoading(false);
                    setError(loadError instanceof Error ? loadError.message : "Couldn't read the Proton session.");
                }
            }
        };
        void load();
        return () => {
            disposed = true;
        };
    }, [customMode]);

    useEffect(() => {
        if (page !== "route" || customMode || !Native) return;
        let disposed = false;
        const refresh = async () => {
            const request = ++optimizationStatusRequestRef.current;
            try {
                const next = await Native.getProtonOptimizationStatus() as PluginOptimizationStatus;
                const currentRequestId = optimizationRequestRef.current;
                const belongsToCurrentAttempt = typeof currentRequestId === "string"
                    && currentRequestId.length > 0
                    && next.requestId === currentRequestId;
                if (!disposed && !disposedRef.current && request === optimizationStatusRequestRef.current
                    && !requireFreshOptimizationRef.current && belongsToCurrentAttempt) setOptimization(next);
            } catch (statusError) {
                if (!disposed && !disposedRef.current) recordRendererError("Falha ao ler progresso da otimização Proton", statusError);
            }
        };
        void refresh();
        const timer = setInterval(() => void refresh(), 750);
        return () => {
            disposed = true;
            optimizationStatusRequestRef.current++;
            clearInterval(timer);
        };
    }, [page, customMode]);

    useEffect(() => {
        if (!routeSelectionActive || busy || routeSelection.applyingServer) return;
        // A otimização automática também mede candidatas: reler o snapshot
        // mantém a lista manual com ping e estado mais recentes da sessão.
        void routeSelection.refresh();
    }, [routeSelectionActive, busy, routeSelection.applyingServer]);

    const enterRoute = () => {
        // O status nativo é global e pode refletir uma otimização anterior feita
        // no painel da VPN. A página só deve aceitar dados da tentativa criada
        // por este assistente.
        requireFreshOptimizationRef.current = true;
        optimizationRequestRef.current = null;
        optimizationStatusRequestRef.current++;
        setRequestId(null);
        setOptimization(null);
        setPage("route");
    };
    const selectCustomConfig = async () => {
        if (!Native || busy || typeof Native.selectWireGuardConfig !== "function") return;
        setBusy(true);
        setError(null);
        try {
            const result = await Native.selectWireGuardConfig() as {
                success?: boolean;
                cancelled?: boolean;
                path?: string;
                error?: string;
            };
            if (disposedRef.current || result.cancelled) return;
            if (result.success !== true || typeof result.path !== "string" || !result.path) {
                throw new Error(result.error || "Couldn't import the WireGuard file.");
            }
            settings.store.customConfigPath = result.path;
            setCustomConfigPath(result.path);
        } catch (selectError) {
            if (!disposedRef.current) {
                setError(selectError instanceof Error ? selectError.message : "Couldn't import the WireGuard file.");
            }
        } finally {
            if (!disposedRef.current) setBusy(false);
        }
    };

    const switchVpnMode = (mode: "proton" | "custom") => {
        if (busy) return;
        settings.store.vpnMode = mode;
        setPage("account");
        setError(null);
    };

    const continueToRoute = async () => {
        if (!Native || busy || sessionLoading || (!customMode && !username.trim())) return;
        const revision = accountRevisionRef.current;
        setError(null);
        setBusy(true);
        try {
            if (customMode) {
                setSession(null);
                enterRoute();
                return;
            }
            let verified = session?.valid && typeof session.username === "string" && protonUsernamesMatch(session.username, username) ? session : null;
            if (!verified) {
                if (!password) {
                    // Sem senha não há o que tentar. O motivo pelo qual a sessão
                    // guardada não serve entra na mensagem, sem chamá-la de
                    // expirada: pode ser armazenamento local, rede ou helper.
                    const detail = session && !session.valid && session.code && session.code !== "INVALID_SESSION"
                        ? (session.error || protonSessionStatusTitle(session.code))
                        : null;
                    setError(detail
                        ? `${detail} Enter your password to sign in again.`
                        : "Enter your password to start a new session or renew this one.");
                    return;
                }
                const loginRequestId = `plugin-onboarding-login-${Date.now()}-${Math.random().toString(16).slice(2)}`;
                loginRequestIdRef.current = loginRequestId;
                setLoginCancelRequested(false);
                const loginResult = await Native.loginProton({ username: username.trim(), password, twoFactorCode, requestId: loginRequestId });
                if (loginRequestIdRef.current === loginRequestId) loginRequestIdRef.current = null;
                if (disposedRef.current || revision !== accountRevisionRef.current) return;
                if (!loginResult.success) {
                    // Apresentação única: o código estruturado do helper manda.
                    // Só a credencial rejeitada devolve o foco para a senha.
                    const presentation = protonLoginPresentation(loginResult);
                    setError(presentation.message);
                    if (presentation.focusPassword) passwordRef.current?.focus();
                    return;
                }
                setPassword("");
                setTwoFactorCode("");
                const checked = await checkSession(username);
                if (disposedRef.current || revision !== accountRevisionRef.current) return;
                if (!checked) return;
                if (!checked.valid) {
                    if (checked.code === "NETWORK_ERROR" || checked.code === "TIMEOUT") {
                        setError("Signed in, but session validation is unavailable right now because of the network. Try again before optimizing.");
                    } else {
                        setError(checked.error || "The saved session didn't pass validation.");
                    }
                    return;
                }
                verified = checked;
            }
            if (!verified) return;
            if (disposedRef.current || revision !== accountRevisionRef.current) return;
            setSession(verified);
            enterRoute();
        } catch (continueError) {
            if (!disposedRef.current && revision === accountRevisionRef.current) {
                setError(continueError instanceof Error ? continueError.message : "Couldn't finish the Proton account step.");
            }
        } finally {
            loginRequestIdRef.current = null;
            if (!disposedRef.current) setLoginCancelRequested(false);
            if (!disposedRef.current) setBusy(false);
        }
    };

    const optimizeRoute = async () => {
        if (!Native || busy) return;
        const nextRequestId = `plugin-onboarding-${Date.now()}`;
        const attempt = ++optimizationAttemptRef.current;
        const isOptimizationCurrent = () => !disposedRef.current && attempt === optimizationAttemptRef.current;
        optimizationStatusRequestRef.current++;
        requireFreshOptimizationRef.current = false;
        optimizationRequestRef.current = customMode ? null : nextRequestId;
        setRequestId(nextRequestId);
        setOptimization({
            active: true,
            requestId: nextRequestId,
            phase: "preparing",
            total: 0,
            tested: 0,
            succeeded: 0,
            updatedAt: Date.now(),
        });
        setBusy(true);
        setError(null);
        try {
            if (customMode) {
                const result = await withTimeout(
                    () => Native.testWireGuardConfig(customConfigPath) as Promise<{ success?: boolean; error?: string }>,
                    CUSTOM_WIREGUARD_VALIDATION_TIMEOUT_MS,
                    "WireGuard config validation timed out. Cancel and try again.",
                );
                if (!isOptimizationCurrent()) return;
                if (result.success !== true) throw new Error(result.error || "The custom WireGuard config didn't pass validation.");
                setOptimization({
                    active: false,
                    requestId: nextRequestId,
                    phase: "completed",
                    total: 0,
                    tested: 0,
                    succeeded: 0,
                    updatedAt: Date.now(),
                });
                setPage("ready");
                return;
            }
            const result = await Native.optimizeProtonRoute({
                requestId: nextRequestId,
                speedTest: true,
                country: settings.store.protonCountry,
                freeOnly: settings.store.protonFreeOnly,
                autoPing: settings.store.protonAutoPing,
            });
            if (!isOptimizationCurrent()) return;
            if (!result.success && "cancelled" in result && result.cancelled) {
                setOptimization(current => current ? { ...current, active: false, phase: "cancelled", error: result.error, updatedAt: Date.now() } : {
                    active: false,
                    requestId: nextRequestId,
                    phase: "cancelled",
                    total: 0,
                    tested: 0,
                    succeeded: 0,
                    error: result.error,
                    updatedAt: Date.now(),
                });
                setError("Optimization cancelled. You can try again.");
                return;
            }
            if (!result.success) throw new Error(result.error || "Couldn't optimize the Proton route.");
            setOptimization({
                active: false,
                requestId: nextRequestId,
                phase: "completed",
                total: result.speedTested || 0,
                tested: result.speedTested || 0,
                succeeded: result.speedSucceeded || 0,
                server: result.server,
                pingMs: result.pingMs,
                downloadMbps: result.downloadMbps,
                uploadMbps: result.uploadMbps,
                updatedAt: Date.now(),
            });
            setRouteSource("automatic");
            setPage("ready");
        } catch (optimizeError) {
            if (isOptimizationCurrent()) {
                const detail = optimizeError instanceof Error ? optimizeError.message : "The Proton optimization failed.";
                setOptimization(current => ({
                    active: false,
                    requestId: nextRequestId,
                    phase: "failed",
                    total: current?.total ?? 0,
                    tested: current?.tested ?? 0,
                    succeeded: current?.succeeded ?? 0,
                    server: current?.server,
                    pingMs: current?.pingMs,
                    downloadMbps: current?.downloadMbps,
                    uploadMbps: current?.uploadMbps,
                    error: detail,
                    updatedAt: Date.now(),
                }));
                setError(detail);
                // A otimização automática não achou rota utilizável: a lista
                // manual (ordenada por ping) é a saída, e precisa estar medida.
                routeSelection.measureCatalogIfEmpty();
            }
        } finally {
            if (isOptimizationCurrent()) {
                optimizationRequestRef.current = null;
                setBusy(false);
            }
        }
    };

    const cancelOptimization = () => {
        if (!busy) return;
        cancelActiveOptimization();
        setRequestId(null);
        setOptimization(current => current ? {
            ...current,
            active: false,
            phase: "cancelled",
            error: customMode ? "Validation cancelled." : "Optimization cancelled.",
            updatedAt: Date.now(),
        } : null);
        setError(customMode ? "Validation cancelled. You can try again." : "Optimization cancelled. You can try again.");
        setBusy(false);
    };

    const progress = optimization;
    const progressPercent = progress && progress.total > 0
        ? Math.min(100, Math.round((progress.tested / progress.total) * 100))
        : null;
    const progressIsIndeterminate = progress?.active === true && progressPercent === null;
    const phaseLabel = customMode
        ? progress?.phase === "preparing" ? "validating config"
            : progress?.phase === "completed" ? "config validated"
            : progress?.phase === "failed" ? "validation failed"
                : progress?.phase === "cancelled" ? "validation cancelled"
                    : "ready to validate"
        : progress?.phase === "ping" ? "measuring latency"
            : progress?.phase === "testing" ? "testing servers"
                : progress?.phase === "finalizing" ? "finishing the config"
                    : progress?.phase === "completed" ? "route ready"
                        : progress?.phase === "failed" ? "optimization failed"
                            : progress?.phase === "cancelled" ? "optimization cancelled"
                                : "preparing the selection";

    const routeReady = progress?.phase === "completed" || manualRouteServer !== null;
    const routeFailure = !busy && (progress?.phase === "failed" || progress?.phase === "cancelled") ? error : null;

    const actions = page === "account" ? [
        { text: busy ? (customMode ? "Validating…" : "Signing in…") : customMode ? "Continue to the real route" : "Continue to the real route", variant: "primary" as const, onClick: () => void continueToRoute(), disabled: busy || sessionLoading || (!customMode && !username.trim()) },
        ...(busy && !customMode ? [{ text: loginCancelRequested ? "Cancelling…" : "Cancel sign-in", variant: "danger" as const, onClick: cancelActiveLogin, disabled: loginCancelRequested }] : []),
        // Adiar é fechar e gravar o skip (closeModal); não conclui o onboarding
        // nem libera ativação automática — só destrava o painel para configurar depois.
        { text: "Set up later", variant: "secondary" as const, onClick: closeModal },
    ] : page === "route" ? (customMode ? [
        { text: "Back", variant: "secondary" as const, onClick: () => { if (!busy) setPage("account"); }, disabled: busy },
        busy
            ? { text: "Cancel validation", variant: "danger" as const, onClick: cancelOptimization }
            : { text: progress?.phase === "completed" ? "Continue" : "Validate the real route", variant: "primary" as const, onClick: progress?.phase === "completed" ? () => setPage("ready") : () => void optimizeRoute() },
    ] : [
        // A ação automática vive na seção compartilhada, acima da lista. O
        // rodapé só progride depois de uma otimização concluída ou de uma rota
        // manual realmente aplicada — nunca com um perfil de outra conta.
        { text: "Back", variant: "secondary" as const, onClick: () => { if (!busy && !routeSelection.applyingServer) setPage("account"); }, disabled: busy || Boolean(routeSelection.applyingServer) },
        busy
            ? { text: "Cancel optimization", variant: "danger" as const, onClick: cancelOptimization }
            : { text: "Continue", variant: "primary" as const, onClick: () => setPage("ready"), disabled: !routeReady },
    ]) : [
        { text: "Turn on VPN and restart Discord", variant: "primary" as const, onClick: complete },
    ];
    const pageHeading = page === "account"
        ? customMode ? "1. Set up your WireGuard route" : "1. Connect your ProtonVPN account"
        : page === "route"
            ? customMode ? "2. Validate your real WireGuard route" : "2. Prepare and test your real route"
            : customMode ? "3. Setup finished and validated" : "3. Real route prepared and ready";

    if (!Native) {
        return <Modal {...modalProps} onClose={closeModal} title="GoLiveBypass setup" size="md" actions={[{ text: "Close", variant: "secondary", onClick: closeModal }]}>
            <Paragraph>The plugin's native part isn't available in this install. The WireGuard transport needs the desktop bridge on supported clients (Windows x64 and Linux x64).</Paragraph>
        </Modal>;
    }

    return (
        <Modal {...modalProps} onClose={closeModal} title="Set up GoLiveBypass" size="md" actions={actions}>
            <div style={{ maxHeight: "min(60vh, 560px)", overflowY: "auto", overflowX: "hidden", paddingRight: "4px", minWidth: 0 }}>
                <OnboardingSteps page={page} customMode={customMode} />
                <h2 ref={pageHeadingRef} tabIndex={-1} style={{ margin: "0 0 12px", color: "var(--header-primary)" }}>{pageHeading}</h2>
                {page === "account" && (
                    <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                    {customMode ? (
                        <>
                            <Paragraph>Custom mode doesn't use a Proton account or ask for credentials. In the next step, the plugin validates the real WireGuard route you set up before finishing.</Paragraph>
                            {vpnStatus?.platform === "unsupported" && (
                                <Paragraph role="alert" aria-live="polite">
                                    <strong>Platform not supported:</strong> {vpnStatus.externalReason || "The WireGuard transport requires Windows x64 or Linux x64."}
                                </Paragraph>
                            )}
                            {Boolean(vpnStatus?.dependencies && vpnStatus.dependencies.length > 0) && (
                                <Paragraph role="alert" aria-live="polite">
                                    <strong>System dependencies:</strong> Missing packages ({vpnStatus!.dependencies!.join(", ")}). You can validate the file now, but turning on will require installing them.
                                </Paragraph>
                            )}
                            <Button onClick={() => void selectCustomConfig()} disabled={busy || sessionLoading}>
                                {customConfigPath.trim() ? "Change .conf file" : "Select .conf file"}
                            </Button>
                            <div style={onboardingBoxStyle} role="status" aria-live="polite" aria-busy={busy}>
                                <Paragraph>{customConfigPath.trim() ? "WireGuard file imported to the plugin's private folder." : "No custom WireGuard file has been set up yet."}</Paragraph>
                            </div>
                            <Button onClick={() => switchVpnMode("proton")} disabled={busy}>
                                Use the plugin's Proton VPN
                            </Button>
                            {error && <Paragraph role="alert" aria-live="assertive"><strong>{error}</strong></Paragraph>}
                        </>
                    ) : (
                        <>
                            <Paragraph>The session is validated and stays only in the plugin's protected storage. Passwords and codes never appear in diagnostics.</Paragraph>
                            {vpnStatus?.sessionStorage === "memory-only" && (
                                <Paragraph role="note" aria-live="polite">
                                    <strong>This computer can't save the session:</strong> the system's secure storage (Secret Service/libsecret) isn't available. You sign in as usual, but the session only lasts while Discord is open and you'll have to sign in again after restarting it. Nothing is written to disk in plain text.
                                </Paragraph>
                            )}
                            {vpnStatus?.platform === "unsupported" && (
                                <Paragraph role="alert" aria-live="polite">
                                    <strong>Platform not supported:</strong> {vpnStatus.externalReason || "The WireGuard transport requires Windows x64 or Linux x64."}
                                </Paragraph>
                            )}
                            {Boolean(vpnStatus?.dependencies && vpnStatus.dependencies.length > 0) && (
                                <Paragraph role="alert" aria-live="polite">
                                    <strong>System dependencies:</strong> Missing packages ({vpnStatus!.dependencies!.join(", ")}). You can prepare the route now, but turning on will require installing them.
                                </Paragraph>
                            )}
                            <TextInput value={username} onChange={value => {
                                if (!protonUsernamesMatch(value, username)) {
                                    accountRevisionRef.current++;
                                    sessionCheckRef.current++;
                                    setSession(null);
                                    setPassword("");
                                    setTwoFactorCode("");
                                    setOptimization(null);
                                    setRequestId(null);
                                    optimizationRequestRef.current = null;
                                    optimizationAttemptRef.current++;
                                    optimizationStatusRequestRef.current++;
                                    requireFreshOptimizationRef.current = true;
                                    setSessionLoading(false);
                                    setError(null);
                                }
                                setUsername(value);
                            }} placeholder="ProtonVPN username" aria-label="ProtonVPN username" disabled={busy} />
                            <TextInput inputRef={passwordRef} value={password} onChange={setPassword} placeholder="ProtonVPN password" aria-label="ProtonVPN password" type="password" disabled={busy} />
                            <TextInput value={twoFactorCode} onChange={setTwoFactorCode} placeholder="2FA code (if asked)" aria-label="2FA code (if asked)" disabled={busy} />
                            {sessionLoading && <Paragraph>Checking the saved session…</Paragraph>}
                            {!sessionLoading && session?.valid && <Paragraph><strong>Session valid</strong>{session.expiresIn ? ` · expires ${session.expiresIn}` : ""}. You can continue without typing your password.</Paragraph>}
                            {!sessionLoading && session && !session.valid && <Paragraph><strong>{protonSessionStatusTitle(session.code)}</strong>{session.error ? ` · ${session.error}` : ""}</Paragraph>}
                            {error && <Paragraph role="alert" aria-live="assertive"><strong>{error}</strong></Paragraph>}
                            {!!username.trim() && !sessionLoading && <Button onClick={() => void checkSession(username)} disabled={busy}>Check session again</Button>}
                            <Button onClick={() => switchVpnMode("custom")} disabled={busy || sessionLoading}>
                                Use my own VPN (Mullvad or another WireGuard)
                            </Button>
                            <Paragraph>Have Mullvad or another VPN with a .conf file? Switch modes now and import the file in the next step, with no Proton sign-in.</Paragraph>
                        </>
                    )}
                    </div>
                )}
                {page === "route" && (
                    <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                    <Paragraph>{customMode ? "The plugin will validate the WireGuard config chosen in the options. The WireGuard tunnel isolates only the Discord client (through AllowedApps on Windows or a network namespace on Linux). Network probes are connectivity diagnostics and don't prove geographic location." : "The plugin can choose the route automatically, or you can choose a Proton route from the list below. The WireGuard tunnel isolates only the Discord client (through AllowedApps on Windows or a network namespace on Linux). Network probes are connectivity diagnostics and don't prove geographic location."}</Paragraph>
                    {customMode ? (
                        <>
                        <div style={onboardingBoxStyle} role="status" aria-live="polite" aria-busy={busy}>
                            <div style={{ display: "flex", justifyContent: "space-between", gap: "12px", flexWrap: "wrap" }}><strong>Route state</strong><span>{phaseLabel}</span></div>
                            {(progressPercent !== null || progressIsIndeterminate) && <progress {...(progressPercent === null ? {} : { value: progressPercent })} max={100} aria-label="Route validation progress" aria-valuetext={progressPercent === null ? "Validation running; total not known yet" : `${progressPercent}%`} style={{ width: "100%", marginTop: "12px" }} />}
                            {progress && progress.total > 0 && <Paragraph>{progress.tested} of {progress.total} servers tested · {progress.succeeded} passed</Paragraph>}
                            {progress?.server && <Paragraph>Selected server: {progress.server}</Paragraph>}
                            {typeof progress?.pingMs === "number" && <Paragraph>Measured latency: {progress.pingMs} ms</Paragraph>}
                            {progress?.phase === "completed" && <Paragraph>The WireGuard route was validated. Click Continue and, when you finish, the plugin turns on the tunnel and restarts Discord.</Paragraph>}
                        </div>
                        {error && <Paragraph role="alert" aria-live="assertive"><strong>{error}</strong></Paragraph>}
                        </>
                    ) : (
                        <ProtonRouteSelection
                            routes={routeSelection.routes}
                            recommendedServer={routeSelection.recommendedServer}
                            discovery={routeSelection.discovery}
                            optimization={{ active: busy, label: vpnRouteStateLabel({ status: vpnStatus, optimizing: busy, optimizationNotice: phaseLabel }), error: routeFailure, progress }}
                            applyingServer={routeSelection.applyingServer}
                            selectionError={routeSelection.selectionError}
                            lockedReason={routeSelectionActive ? null : "Sign in with a valid Proton account to list the routes."}
                            emptyMessage={routeSelection.discovery.active
                                ? "Finding Proton routes and measuring ping…"
                                : "No Proton route was cataloged. Optimize automatically or use \"Find routes again\"."}
                            activeRoute={vpnStatus?.route ?? null}
                            routeActive={Boolean(vpnStatus?.active)}
                            onOptimize={() => void optimizeRoute()}
                            onDiscover={routeSelection.restart}
                            onSelect={routeSelection.select}
                            onCancelSelection={routeSelection.cancelSelection}
                        />
                    )}
                    </div>
                )}
                {page === "ready" && (
                    <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                    <div style={onboardingBoxStyle} role="status" aria-live="polite">
                        <Paragraph>{customMode ? "The custom WireGuard config passed validation. When you finish, the plugin turns on the tunnel and restarts Discord so the route takes effect. Network probes are connectivity diagnostics and don't prove geographic location." : `${routeSource === "manual" ? "The Proton route chosen from the list" : "The real Proton route"} is ready. When you finish, the plugin turns on the tunnel and restarts Discord so the route takes effect. Network probes are connectivity diagnostics and don't prove geographic location.`}</Paragraph>
                        {vpnStatus?.platform === "linux" && (
                            <Paragraph>On Linux, turning on moves the Discord client into its own network namespace, asks for elevation (pkexec) if needed and relaunches the client.</Paragraph>
                        )}
                        {routeSource === "manual" && manualRouteServer && <Paragraph>Server chosen from the list: {manualRouteServer}</Paragraph>}
                        {routeSource !== "manual" && progress?.server && <Paragraph>Chosen server: {progress.server}</Paragraph>}
                        {typeof progress?.downloadMbps === "number" && typeof progress.uploadMbps === "number" && <Paragraph>Measured: {progress.downloadMbps} Mbps down · {progress.uploadMbps} Mbps up</Paragraph>}
                    </div>
                    </div>
                )}
            </div>
        </Modal>
    );
}

function openPluginOnboarding() {
    if (onboardingOpen) return;
    if (onboardingTimer !== null) {
        clearTimeout(onboardingTimer);
        onboardingTimer = null;
    }
    onboardingOpen = true;
    const modalToken = ++onboardingModalToken;
    try {
        const modalKey = openModal(props => <PluginOnboardingModal modalProps={props} onClosed={() => {
            if (modalToken !== onboardingModalToken) return;
            onboardingOpen = false;
            onboardingModalKey = null;
        }} />);
        if (modalToken === onboardingModalToken && onboardingOpen) onboardingModalKey = modalKey;
    } catch (error) {
        onboardingOpen = false;
        onboardingModalKey = null;
        recordRendererError("Falha ao abrir o assistente do GoLiveBypass", error);
    }
}

function AboutPlugin() {
    return (
        <section>
            <Paragraph>Turn the bypass on or off and check its status from the panel. You can also open it from the shield icon at the top of Discord.</Paragraph>
            <Button onClick={openControlPanel}>Open panel</Button>
            <Paragraph>
                Made by bezumiya. Code and issues on <MaskedLink href="https://github.com/bezumiya/GoLiveBypass">GitHub</MaskedLink>.
            </Paragraph>
        </section>
    );
}

function PluginUpdateSettings() {
    const { updateChannel, autoUpdate } = settings.use(["updateChannel", "autoUpdate"]);
    const [state, setState] = useState<{ label: string; tone: "neutral" | "success" | "warning"; available?: boolean }>({
        label: `v${PLUGIN_VERSION} installed`, tone: "neutral", available: false
    });
    const [status, setStatus] = useState<PluginUpdateStatus | null>(null);
    const [busy, setBusy] = useState(false);
    const [operation, setOperation] = useState<"checking" | "updating" | null>(null);
    const mountedRef = React.useRef(false);
    const policyRevisionRef = React.useRef(0);
    const statusRequestRef = React.useRef(0);
    const operationIdRef = React.useRef(0);
    const operationBusyRef = React.useRef(false);
    const selectedUpdatePolicy = {
        enabled: autoUpdate,
        channel: normalizedUpdateChannel(updateChannel),
    };

    const isCurrent = (revision: number) => mountedRef.current && revision === policyRevisionRef.current;

    const refreshStatus = async (revision = policyRevisionRef.current, options?: { preserveAvailable?: boolean }): Promise<PluginUpdateStatus | null> => {
        if (!isCurrent(revision)) return null;
        const request = ++statusRequestRef.current;
        const statusRequest = readPluginUpdateStatus();
        if (!statusRequest) return null;
        const isRequestCurrent = () => isCurrent(revision) && request === statusRequestRef.current;
        try {
            const next = await statusRequest;
            if (!isRequestCurrent()) return null;
            if (!pluginUpdateStatusMatchesPolicy(next, selectedUpdatePolicy)) return null;
            setStatus(next);
            if (next.lastError) {
                notifyPluginUpdateFailure(next.current, next.channel, next.lastError);
            } else {
                lastNotifiedUpdateErrorKey = null;
                lastSuppressedUpdateErrorKey = null;
            }
            if (next.pending) {
                notifyPendingPluginUpdate(next.current, next.pendingVersion, next.pendingChannel || next.channel);
                const version = next.pendingVersion ? `v${next.pendingVersion}` : "the new version";
                setState({ label: `${version} is ready. Reload Discord`, tone: "warning", available: false });
            } else if (next.lastError) {
                setState({ label: `v${next.current || PLUGIN_VERSION} · update failed`, tone: "neutral", available: false });
            } else if (!options?.preserveAvailable) {
                setState(prev => ({ label: prev.label, tone: prev.tone, available: false }));
            }
            return next;
        } catch (error) {
            if (isRequestCurrent()) {
                recordRendererError("Falha ao consultar o estado do updater do plugin", error);
                setState(prev => ({ ...prev, available: false }));
            }
            return null;
        }
    };

    const beginOperation = (nextOperation: "checking" | "updating") => {
        if (!Native || busy || operationBusyRef.current) return null;
        const operationRevision = policyRevisionRef.current;
        const operationId = ++operationIdRef.current;
        operationBusyRef.current = true;
        setBusy(true);
        setOperation(nextOperation);
        return { operationRevision, operationId };
    };

    const check = async () => {
        const native = Native;
        if (!native) return;
        const operation = beginOperation("checking");
        if (!operation) return;
        const { operationRevision, operationId } = operation;
        const isOperationMounted = () => isCurrent(operationRevision) && operationId === operationIdRef.current;
        try {
            const result = await withTimeout(
                () => native.checkPluginUpdate(selectedUpdatePolicy),
                PLUGIN_UPDATE_CHECK_TIMEOUT_MS,
                "The update check timed out.",
            ) as PluginUpdateCheckResult;
            if (!isOperationMounted()) return;
            const current = result.current || PLUGIN_VERSION;
            let isAvailable = false;
            if (!result.ok) {
                const detailText = result.error || "The updater refused the check.";
                suppressPluginUpdateFailure(result.current, result.channel || selectedUpdatePolicy.channel, detailText);
                const detail = result.error ? ` · ${result.error.slice(0, 48)}` : "";
                setState({ label: `v${current} · check failed${detail}`, tone: "neutral", available: false });
            } else if (result.pending) {
                const version = result.latest ? `v${result.latest}` : "the new version";
                notifyPendingPluginUpdate(result.current, result.latest, result.pendingChannel || result.channel || selectedUpdatePolicy.channel);
                setState({ label: `${version} is ready. Reload Discord`, tone: "warning", available: false });
            } else if (result.available) {
                isAvailable = true;
                setState({ label: `v${current} · v${result.latest || "new"} available`, tone: "warning", available: true });
            } else {
                setState({ label: `v${current} · up to date`, tone: "success", available: false });
            }
            await refreshStatus(operationRevision, { preserveAvailable: isAvailable });
            if (!isOperationMounted()) return;
        } catch (error) {
            if (isOperationMounted()) {
                const detailText = error instanceof Error ? error.message : String(error);
                const currentVersion = status?.current || PLUGIN_VERSION;
                suppressPluginUpdateFailure(currentVersion, status?.channel || selectedUpdatePolicy.channel, detailText);
                const detail = error instanceof Error ? ` · ${error.message.slice(0, 48)}` : "";
                setState({ label: `v${currentVersion} · check failed${detail}`, tone: "neutral", available: false });
            }
        } finally {
            if (operationId === operationIdRef.current) operationBusyRef.current = false;
            if (isOperationMounted()) {
                setBusy(false);
                setOperation(null);
            }
        }
    };

    useEffect(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
            policyRevisionRef.current++;
            operationIdRef.current++;
            operationBusyRef.current = false;
        };
    }, []);

    useEffect(() => {
        const revision = ++policyRevisionRef.current;
        let disposed = false;
        const isRevisionCurrent = () => !disposed && isCurrent(revision);
        setState({
            label: `v${status?.current || PLUGIN_VERSION} · installed`,
            tone: "neutral",
            available: false
        });
        const configure = async () => {
            try {
                const configureUpdates = Native?.configurePluginUpdates;
                if (typeof configureUpdates === "function") {
                    await configureUpdates({
                        enabled: autoUpdate,
                        channel: normalizedUpdateChannel(updateChannel)
                    });
                }
                if (isRevisionCurrent()) await refreshStatus(revision);
            } catch (error) {
                if (isRevisionCurrent()) recordRendererError("Falha ao configurar o updater do plugin", error);
            }
        };
        void configure();

        const timer = setInterval(() => {
            if (isRevisionCurrent()) void refreshStatus(revision);
        }, PLUGIN_UPDATE_STATUS_POLL_INTERVAL_MS);
        return () => {
            disposed = true;
            policyRevisionRef.current++;
            statusRequestRef.current++;
            operationIdRef.current++;
            operationBusyRef.current = false;
            if (mountedRef.current) {
                setBusy(false);
                setOperation(null);
            }
            clearInterval(timer);
        };
    }, [updateChannel, autoUpdate]);

    const update = async () => {
        const native = Native;
        if (!native) return;
        const operation = beginOperation("updating");
        if (!operation) return;
        const { operationRevision, operationId } = operation;
        const isOperationMounted = () => isCurrent(operationRevision) && operationId === operationIdRef.current;
        let failureContext: { current?: string; channel: PluginUpdateChannel; detail: string } | null = null;
        try {
            const result = await withTimeout(
                () => native.updatePlugin(selectedUpdatePolicy),
                PLUGIN_UPDATE_INSTALL_TIMEOUT_MS,
                "The plugin update timed out.",
            ) as PluginUpdateResult;
            if (!isOperationMounted()) return;
            if (!result.ok) {
                const detail = result.error || "The updater refused the update.";
                failureContext = { current: result.current, channel: result.channel || selectedUpdatePolicy.channel, detail };
                suppressPluginUpdateFailure(failureContext.current, failureContext.channel, failureContext.detail);
                setState({ label: `v${result.current || PLUGIN_VERSION} · update failed`, tone: "warning", available: false });
                throw new Error(detail);
            }
            if (result.updated || result.pending || result.reloadRequired) {
                const version = result.latest || result.current;
                notifyPendingPluginUpdate(result.current, version, result.pendingChannel || result.channel || selectedUpdatePolicy.channel);
                setState({
                    label: version ? `v${version} is ready. Reload Discord` : "Update ready. Reload Discord",
                    tone: "warning",
                    available: false
                });
                await refreshStatus(operationRevision);
                if (!isOperationMounted()) return;
            } else {
                setState({ label: `v${result.current || PLUGIN_VERSION} · up to date`, tone: "success", available: false });
            }
        } catch (error) {
            if (isOperationMounted()) {
                const detail = error instanceof Error ? error.message : String(error);
                const currentVersion = failureContext?.current || status?.current || PLUGIN_VERSION;
                suppressPluginUpdateFailure(
                    currentVersion,
                    failureContext?.channel || status?.channel || selectedUpdatePolicy.channel,
                    failureContext?.detail || detail,
                );
                setState({ label: `v${currentVersion} · update failed`, tone: "warning", available: false });
                showToast(`GoLiveBypass couldn't update: ${detail}`, "failure");
            }
        } finally {
            if (operationId === operationIdRef.current) operationBusyRef.current = false;
            if (isOperationMounted()) {
                setBusy(false);
                setOperation(null);
            }
        }
    };

    const channelLabel = updateChannel === "beta" ? "Beta channel" : "Stable channel";
    const checkedLabel = typeof status?.lastCheckedAt === "number"
        ? ` · checked ${new Date(status.lastCheckedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
        : "";
    const operationLabel = operation === "checking"
        ? "Checking for updates…"
        : operation === "updating"
            ? "Downloading and preparing the update…"
            : state.label;

    return (
        <div className="vc-glb-update" role="status" aria-live="polite" aria-busy={busy} aria-atomic="true">
            <div className="vc-glb-update-copy">
                <strong>{operationLabel}</strong>
                <p>{channelLabel} · auto-update {autoUpdate ? "on" : "off"}{checkedLabel}</p>
                {status?.pending && <p>Update {status.pendingVersion ? `v${status.pendingVersion}` : ""} is ready. Reload Discord to apply it.</p>}
                {state.available && <p>Updating replaces this custom panel.</p>}
                {status?.lastError && <p>Last updater error: {status.lastError.slice(0, 240)}</p>}
            </div>
            <div className="vc-glb-row">
                <Button variant="secondary" size="small" onClick={() => void check()} disabled={busy}>{busy ? "Working…" : "Check"}</Button>
                {state.available && <Button size="small" onClick={() => void update()} disabled={busy}>Update</Button>}
            </div>
        </div>
    );
}

const settings = definePluginSettings({
    voiceRegion: {
        type: OptionType.COMPONENT,
        hidden: true,
        component: VoiceRegionPicker,
        default: AUTOMATIC
    },
    streamRegion: {
        type: OptionType.COMPONENT,
        hidden: true,
        component: StreamRegionPicker,
        default: AUTOMATIC
    },
    updateChannel: {
        type: OptionType.SELECT,
        hidden: true,
        description: "Choose whether to get stable versions only or beta versions too.",
        options: [
            { label: "Stable", value: "stable", default: true },
            { label: "Beta", value: "beta" }
        ]
    },
    autoUpdate: {
        type: OptionType.BOOLEAN,
        hidden: true,
        description: "Check for, download and prepare updates in the background. Discord never restarts on its own.",
        default: false
    },
    updateDeferredVersion: {
        type: OptionType.STRING,
        description: "Update version whose notice was postponed.",
        default: "",
        hidden: true,
    },
    updateDeferredUntil: {
        type: OptionType.STRING,
        description: "When the postponed update notice comes back.",
        default: "",
        hidden: true,
    },
    onboardingCompleted: {
        type: OptionType.BOOLEAN,
        description: "Whether first-run setup was completed.",
        default: false,
        hidden: true,
    },
    onboardingSkipped: {
        type: OptionType.BOOLEAN,
        description: "Whether first-run setup was skipped.",
        default: false,
        hidden: true,
    },
    goLive: {
        type: OptionType.BOOLEAN,
        description: "Keep Go Live on whenever Discord is open.",
        default: false,
        hidden: true,
    },
    vpnMode: {
        type: OptionType.SELECT,
        hidden: true,
        description: "WireGuard route for this Discord only. The rest of the computer stays on your normal network.",
        options: [
            { label: "ProtonVPN (recommended)", value: "proton", default: true },
            { label: "Custom WireGuard file", value: "custom" }
        ]
    },
    customConfigPath: {
        type: OptionType.STRING,
        hidden: true,
        description: "WireGuard .conf file imported to the plugin's private folder.",
        default: ""
    },
    protonUsername: {
        type: OptionType.STRING,
        hidden: true,
        description: "ProtonVPN username. The session stays in the plugin's private folder.",
        default: ""
    },
    protonCountry: {
        type: OptionType.STRING,
        hidden: true,
        description: "Preferred Proton countries as two-letter codes separated by commas. Empty lets Proton choose.",
        default: "",
        isValid: (value: string) => value.trim() === "" || value.trim().split(",").every(part => /^[A-Za-z]{2}$/.test(part.trim()))
            || "Use two-letter country codes, for example US, NL."
    },
    protonFreeOnly: {
        type: OptionType.BOOLEAN,
        hidden: true,
        description: "Use only free servers when choosing a route automatically.",
        default: true
    },
    protonAutoPing: {
        type: OptionType.BOOLEAN,
        hidden: true,
        description: "Try the lowest-latency Proton servers first.",
        default: true
    }
});

interface PluginVpnStatus {
    state: VpnState | string;
    managedConflict?: boolean;
    platform?: VpnPlatform | string;
    architecture?: string;
    owned?: boolean;
    active: boolean;
    generation?: number;
    discordPid?: number | null;
    profilePath?: string | null;
    configPath?: string | null;
    namespace?: string | null;
    interfaceName?: string | null;
    requiresRelaunch?: boolean;
    dependencies?: string[];
    goLive?: GoLiveStatus | null;
    externalReason: string | null;
    lastDiagnostic: { detail: string; ok?: boolean; kind?: string } | null;
    message: string;
    sessionStorage?: "safe-storage" | "file" | "memory-only";
    /** Rota do perfil ativo (o plugin novo envia; uma versão antiga do plugin deixa ausente). */
    route?: VpnRouteInfo | null;
}

// Último estado conhecido: o painel abre com ele na hora e atualiza em segundo plano.
let cachedStatus: PluginVpnStatus | null = null;
let cachedUsername = "";
let cachedSession: { username: string; value: ProtonSessionCheck; checkedAt: number; } | null = null;
let onStatusCached: ((status: PluginVpnStatus) => void) | null = null;

// O bloqueio vale pela sessão inteira: ligar o túnel depois não muda o que o servidor decidiu.
const sessionNeedsReconnect = (goLive: GoLiveStatus | null | undefined) => goLive?.state === "active" && videoIsBlocked();

async function turnOnGoLive(): Promise<GoLiveStatus | null> {
    if (typeof Native?.setGoLive !== "function") return null;
    settings.store.goLive = true;
    const goLive = await Native.setGoLive(true) as GoLiveStatus | null;
    if (sessionNeedsReconnect(goLive)) setTimeout(() => location.reload(), 500);
    return goLive;
}

function cacheStatus(status: PluginVpnStatus) {
    cachedStatus = status;
    onStatusCached?.(status);
}

const isSessionCacheFresh = (username: string) =>
    cachedSession?.username === username && Date.now() - cachedSession.checkedAt < PANEL_CACHE_MS;

function useVpnPanelController(): ControlPanelController {
    const { vpnMode, customConfigPath, protonCountry, protonFreeOnly, protonAutoPing } = settings.use(["vpnMode", "customConfigPath", "protonCountry", "protonFreeOnly", "protonAutoPing"]);
    const customMode = vpnMode === "custom";
    const [status, setStatus] = useState<PluginVpnStatus | null>(cachedStatus);
    const [username, setUsername] = useState(cachedUsername);
    const [password, setPassword] = useState("");
    const [twoFactorCode, setTwoFactorCode] = useState("");
    const [busy, setBusy] = useState(false);
    const [optimizing, setOptimizing] = useState(false);
    const [loginActive, setLoginActive] = useState(false);
    const [loginCancelRequested, setLoginCancelRequested] = useState(false);
    const [session, setSession] = useState<ProtonSessionCheck | null>(cachedSession?.username === cachedUsername ? cachedSession.value : null);
    const [loginError, setLoginError] = useState<string | null>(null);
    const [optimizationError, setOptimizationError] = useState<string | null>(null);
    const [optimizationNotice, setOptimizationNotice] = useState("ready to optimize");
    const mountedRef = React.useRef(false);
    const usernameRef = React.useRef(cachedUsername);
    const refreshRequestRef = React.useRef(0);
    const sessionRequestRef = React.useRef(0);
    const checkedUsernameRef = React.useRef(cachedSession?.username === cachedUsername ? cachedUsername : "");
    const loginRequestIdRef = React.useRef<string | null>(null);
    const passwordRef = React.useRef<HTMLInputElement | null>(null);
    const routeSelectionActive = !customMode && session?.valid === true;
    const routeSelection = useProtonRouteSelection({
        active: routeSelectionActive,
        account: username,
        country: protonCountry,
        freeOnly: protonFreeOnly !== false,
        autoPing: protonAutoPing !== false,
    });

    // A sessão é verificada uma vez por conta: a lista manual só existe com
    // sessão Proton válida e não vale a pena spawnar o helper a cada refresh.
    const checkSession = async (value: string) => {
        const native = Native;
        if (!native || !value.trim()) {
            setSession(null);
            return;
        }
        const request = ++sessionRequestRef.current;
        try {
            const result = await native.checkProtonSession(value.trim()) as ProtonSessionCheck;
            cachedSession = { username: value.trim(), value: result, checkedAt: Date.now() };
            if (mountedRef.current && request === sessionRequestRef.current) setSession(result);
        } catch {
            if (mountedRef.current && request === sessionRequestRef.current) {
                setSession({ valid: false, code: "UNKNOWN", error: "Couldn't check the Proton session." });
            }
        }
    };

    const refresh = async (force = false) => {
        if (!Native) return;
        const request = ++refreshRequestRef.current;
        const isCurrent = () => mountedRef.current && request === refreshRequestRef.current;
        try {
            const [nextStatus, saved] = await Promise.all([Native.getVpnStatus(), Native.getProtonSettings()]);
            if (!isCurrent()) return;
            setStatus(nextStatus as PluginVpnStatus);
            cacheStatus(nextStatus as PluginVpnStatus);
            const savedRecord = saved as { protonUsername?: unknown; sessionUsername?: unknown };
            const savedUsername = typeof savedRecord.protonUsername === "string" && savedRecord.protonUsername
                ? savedRecord.protonUsername
                : savedRecord.sessionUsername;
            if (!usernameRef.current && typeof savedUsername === "string" && savedUsername) {
                usernameRef.current = savedUsername;
                setUsername(savedUsername);
            }
            if (typeof savedUsername === "string") cachedUsername = savedUsername;
            const checkTarget = typeof savedUsername === "string" && savedUsername ? savedUsername : "";
            if (checkTarget && (force || checkedUsernameRef.current !== checkTarget || !isSessionCacheFresh(checkTarget))) {
                checkedUsernameRef.current = checkTarget;
                void checkSession(checkTarget);
            }
            // A sessão de medição é única no processo: acompanhar o snapshot
            // mantém o painel coerente quando o assistente faz outra descoberta.
            void routeSelection.refresh();
        } catch (error) {
            if (isCurrent()) recordRendererError("Falha ao ler o estado da VPN do plugin", error);
        }
    };

    useEffect(() => {
        mountedRef.current = true;
        void refresh();
        const timer = setInterval(() => void refresh(), 15_000);
        return () => {
            mountedRef.current = false;
            refreshRequestRef.current++;
            const activeRequestId = loginRequestIdRef.current;
            loginRequestIdRef.current = null;
            if (activeRequestId && typeof Native?.cancelProtonLogin === "function") {
                void Promise.resolve(Native.cancelProtonLogin(activeRequestId)).catch(error => recordRendererError("Falha ao cancelar login Proton ao desmontar o painel", error));
            }
            clearInterval(timer);
        };
    }, []);

    const call = async (operation: () => Promise<unknown>, successMessage?: string) => {
        if (busy) return;
        setBusy(true);
        try {
            const result = await operation() as { success?: boolean; error?: string; message?: string };
            if (!mountedRef.current) return;
            if (result.success === false) throw new Error(result.error || result.message || "The VPN operation was refused.");
            if (successMessage) showToast(successMessage, "success");
            await refresh();
        } catch (error) {
            if (mountedRef.current) showToast(`GoLiveBypass: ${error instanceof Error ? error.message : String(error)}`, "failure");
        } finally {
            if (mountedRef.current) setBusy(false);
        }
    };
    const selectCustomConfig = async () => {
        if (!Native || busy || optimizing || typeof Native.selectWireGuardConfig !== "function") return;
        setBusy(true);
        try {
            const result = await Native.selectWireGuardConfig() as {
                success?: boolean;
                cancelled?: boolean;
                path?: string;
                error?: string;
            };
            if (!mountedRef.current || result.cancelled) return;
            if (result.success !== true || typeof result.path !== "string" || !result.path) {
                throw new Error(result.error || "Couldn't import the WireGuard file.");
            }
            settings.store.customConfigPath = result.path;
            showToast("WireGuard file imported.", "success");
            await refresh();
        } catch (error) {
            if (mountedRef.current) showToast(`GoLiveBypass: ${error instanceof Error ? error.message : String(error)}`, "failure");
        } finally {
            if (mountedRef.current) setBusy(false);
        }
    };

    const login = async () => {
        if (!Native || busy || optimizing) return;
        const requestId = `plugin-panel-login-${Date.now()}-${Math.random().toString(16).slice(2)}`;
        loginRequestIdRef.current = requestId;
        setLoginActive(true);
        setLoginCancelRequested(false);
        setLoginError(null);
        setBusy(true);
        try {
            const result = await Native.loginProton({ username, password, twoFactorCode, requestId });
            if (!mountedRef.current) return;
            if (!result.success) {
                // Mesma apresentação do assistente: código estruturado manda e
                // só a credencial rejeitada devolve o foco para a senha.
                const presentation = protonLoginPresentation(result);
                setLoginError(presentation.message);
                if (presentation.focusPassword) passwordRef.current?.focus();
                return;
            }
            setLoginError(null);
            checkedUsernameRef.current = "";
            setPassword("");
            setTwoFactorCode("");
            showToast(
                result.persisted === false
                    ? "Signed in to Proton until Discord restarts. This computer can't save the session."
                    : "Proton session saved in the plugin's private folder.",
                "success"
            );
            await refresh();
        } catch (error) {
            if (mountedRef.current) {
                setLoginError(safeDiagnosticDetail(error || "Couldn't finish signing in to Proton.", 240));
            }
        } finally {
            if (loginRequestIdRef.current === requestId) loginRequestIdRef.current = null;
            if (mountedRef.current) {
                setLoginActive(false);
                setLoginCancelRequested(false);
            }
            if (mountedRef.current) setBusy(false);
        }
    };

    const cancelLogin = () => {
        const activeRequestId = loginRequestIdRef.current;
        if (!activeRequestId || loginCancelRequested || typeof Native?.cancelProtonLogin !== "function") return;
        setLoginCancelRequested(true);
        setPassword("");
        setTwoFactorCode("");
        void Promise.resolve(Native.cancelProtonLogin(activeRequestId)).catch(error => recordRendererError("Falha ao cancelar login Proton", error));
    };

    const optimize = async () => {
        if (!Native || busy || optimizing) return;
        setOptimizing(true);
        setOptimizationError(null);
        try {
            const result = await Native.optimizeProtonRoute({
                requestId: `plugin-${Date.now()}`,
                speedTest: true,
                country: settings.store.protonCountry,
                freeOnly: settings.store.protonFreeOnly,
                autoPing: settings.store.protonAutoPing
            });
            if (!mountedRef.current) return;
            if (!result.success) {
                // A falha fica junto da ação automática; a lista manual continua
                // disponível logo abaixo, sem esconder as rotas já medidas. O
                // orçamento cobre a sonda estendida anexada pelo helper.
                setOptimizationError(safeDiagnosticDetail(result.error || "Couldn't optimize the Proton route.", 500));
                setOptimizationNotice("optimization failed; pick a route from the list");
                routeSelection.measureCatalogIfEmpty();
                return;
            }
            setOptimizationNotice("Proton route ready");
            showToast(
                status?.active
                    ? "Proton route ready and applied to this Discord session."
                    : "Proton route ready.",
                "success"
            );
            await refresh();
            await routeSelection.refresh();
        } catch (error) {
            if (mountedRef.current) {
                setOptimizationError(safeDiagnosticDetail(error || "Couldn't optimize the Proton route.", 240));
                setOptimizationNotice("optimization failed; pick a route from the list");
                routeSelection.measureCatalogIfEmpty();
            }
        } finally {
            if (mountedRef.current) setOptimizing(false);
        }
    };

    useEffect(() => {
        if (!routeSelection.appliedServer) return;
        showToast(`Proton route applied: ${routeSelection.appliedServer}.`, "success");
        void refresh();
    }, [routeSelection.appliedServer]);

    const missingDependencies = Boolean(status?.dependencies && status.dependencies.length > 0);
    const isDependencyMissing = status?.state === "dependency_missing" || missingDependencies;
    const activationBlockReason = status?.platform === "unsupported"
        ? (status?.externalReason || "Platform not supported")
        : isDependencyMissing
            ? (status?.dependencies?.length ? `Missing dependencies: ${status.dependencies.join(", ")}` : (status?.externalReason || "Missing dependencies"))
            : status?.state === "blocked_external" && !status?.managedConflict
                ? (status?.externalReason || "Another tunnel is running")
                : status?.state === "recovery_required"
                    ? "Network recovery pending"
                    : status?.requiresRelaunch
                        ? "Restart required"
                        : null;
    const canActivate = Boolean(status && !busy && !optimizing && !routeSelection.applyingServer && !status.active && !activationBlockReason);

    return {
        status: status as ControlPanelController["status"],
        session,
        sessionTitle: session && !session.valid ? protonSessionStatusTitle(session.code) : null,
        customMode,
        customConfigPath: typeof customConfigPath === "string" ? customConfigPath : "",
        protonCountry: typeof protonCountry === "string" ? protonCountry : "",
        protonFreeOnly: protonFreeOnly !== false,
        protonAutoPing: protonAutoPing !== false,
        username,
        password,
        twoFactorCode,
        passwordRef,
        busy,
        optimizing,
        loginActive,
        loginCancelRequested,
        loginError,
        optimizationError,
        optimizationLabel: vpnRouteStateLabel({ status, optimizing, optimizationNotice }),
        routes: routeSelection.routes,
        recommendedServer: routeSelection.recommendedServer ?? null,
        discoveryActive: routeSelection.discovery.active,
        discoveryError: routeSelection.discovery.error,
        applyingServer: routeSelection.applyingServer,
        selectionError: routeSelection.selectionError,
        activationBlockReason,
        canActivate,
        goLiveBlocked: videoIsBlocked(),
        needsReconnect: sessionNeedsReconnect(status?.goLive),
        setUsername: value => {
            if (!protonUsernamesMatch(value, username)) {
                checkedUsernameRef.current = "";
                cachedSession = null;
                setSession(null);
                setLoginError(null);
                setPassword("");
                setTwoFactorCode("");
            }
            usernameRef.current = value;
            setUsername(value);
        },
        setPassword,
        setTwoFactorCode,
        setVpnMode: mode => { settings.store.vpnMode = mode; },
        setProtonCountry: value => { settings.store.protonCountry = value; },
        setProtonFreeOnly: value => { settings.store.protonFreeOnly = value; },
        setProtonAutoPing: value => { settings.store.protonAutoPing = value; },
        refresh: async () => {
            await Native?.checkGoLive?.();
            await refresh(true);
        },
        activate: () => void call(() => Native!.enable()),
        goLive: () => void call(async () => {
            const goLive = await turnOnGoLive();
            return { success: goLive?.state === "active", error: goLive?.error ?? "Go Live didn't start." };
        }),
        turnOffGoLive: () => void call(async () => {
            settings.store.goLive = false;
            await Native!.setGoLive(false);
            return { success: true };
        }, "Go Live is off."),
        reconnect: () => location.reload(),
        restartClient: () => void call(() => (typeof Native?.restartDiscord === "function" ? Native.restartDiscord() : Native!.enable()), "Restarting Discord…"),
        restoreNetwork: () => void call(() => Native!.restoreNetwork(), "Network restored."),
        testConfig: () => void call(() => Native!.testWireGuardConfig(customConfigPath), "File tested."),
        selectCustomConfig: () => void selectCustomConfig(),
        login: () => void login(),
        cancelLogin,
        logout: () => void call(async () => {
            const result = await Native!.logoutProton();
            // Sair invalida a sessão: catálogo, medição e seleção
            // pendente são cancelados e apagados da interface.
            checkedUsernameRef.current = "";
            sessionRequestRef.current++;
            cachedSession = null;
            setSession(null);
            return result;
        }, "Signed out of Proton."),
        optimize: () => void optimize(),
        discoverRoutes: routeSelection.restart,
        selectRoute: routeSelection.select,
        cancelRouteSelection: routeSelection.cancelSelection,
        copyDiagnostic: () => void buildReport().then(report => copyWithToast(report, "Diagnostics copied.")),
        reportBug: openBugReport,
    };
}

function ControlPanelHost({ modalProps }: { modalProps: RenderModalProps; }) {
    const controller = useVpnPanelController();
    return (
        <ControlPanel
            modalProps={modalProps}
            controller={controller}
            unavailable={!Native}
            regions={<><div className="vc-glb-field"><span>Voice region</span><VoiceRegionPicker /></div><div className="vc-glb-field"><span>Go Live region</span><StreamRegionPicker /></div></>}
            updates={<PluginUpdateSettings />}
        />
    );
}

function openControlPanel() {
    try {
        openModal(props => <ControlPanelHost modalProps={props} />);
    } catch (error) {
        recordRendererError("Falha ao abrir o painel do GoLiveBypass", error);
    }
}

function ControlPanelButton() {
    const [tone, setTone] = useState<PanelTone>(() => panelTone(cachedStatus));

    useEffect(() => {
        let cancelled = false;
        onStatusCached = status => setTone(panelTone(status));
        const read = () => {
            if (document.hidden || !Native) return;
            void Native.getVpnStatus()
                .then(status => { if (!cancelled) cacheStatus(status as PluginVpnStatus); })
                .catch(error => recordRendererError("Falha ao ler o estado para o ícone do topo", error));
        };
        read();
        const timer = setInterval(read, 60_000);
        return () => {
            cancelled = true;
            onStatusCached = null;
            clearInterval(timer);
        };
    }, []);

    return <HeaderBarButton onClick={openControlPanel} tooltip={`GoLiveBypass: ${PANEL_TONE_LABEL[tone]}`} aria-label={`GoLiveBypass, ${PANEL_TONE_LABEL[tone]}`} icon={panelIconFor(tone)} />;
}

function forcedRegion() {
    const region = settings.store.voiceRegion;
    if (typeof region !== "string") return null;

    const trimmed = region.trim();
    return trimmed === AUTOMATIC ? null : trimmed;
}

function forceRegion() {
    if (original !== undefined) return;

    const store = RTCRegionStore;
    if (typeof store.getPreferredRegion !== "function"
        || typeof store.getPreferredRegions !== "function"
        || typeof store.shouldIncludePreferredRegion !== "function") {
        showToast("GoLiveBypass could not find Discord's region picker, so your call region is untouched.", "failure");
        return;
    }

    const saved: RegionStore = {
        getPreferredRegion: store.getPreferredRegion,
        getPreferredRegions: store.getPreferredRegions,
        shouldIncludePreferredRegion: store.shouldIncludePreferredRegion
    };

    store.getPreferredRegion = function () {
        return forcedRegion() ?? saved.getPreferredRegion.call(this);
    };

    store.getPreferredRegions = function () {
        const forced = forcedRegion();
        const ranked = saved.getPreferredRegions.call(this);
        return forced === null ? ranked : [forced, ...(ranked ?? []).filter(region => region !== forced)];
    };

    store.shouldIncludePreferredRegion = function () {
        return forcedRegion() !== null || saved.shouldIncludePreferredRegion.call(this);
    };

    original = saved;
}

function restoreRegion() {
    if (original === undefined) return;

    RTCRegionStore.getPreferredRegion = original.getPreferredRegion;
    RTCRegionStore.getPreferredRegions = original.getPreferredRegions;
    RTCRegionStore.shouldIncludePreferredRegion = original.shouldIncludePreferredRegion;
    original = undefined;
}

function videoIsBlocked() {
    const user = UserStore.getCurrentUser();
    if (user == null) return false;

    const assignment = ApexExperimentStore.getServerAssignment("user", user.id, VIDEO_GUARD);
    if (assignment === null || typeof assignment !== "object") return false;

    // As duas variacoes do experimento desligam video; o balde de controle nao tem nenhuma
    // delas. Ler supportsInApp aqui seria inutil: o patch do plugin deixa esse valor sempre
    // verdadeiro, e a checagem nunca detectaria bloqueio nenhum.
    const { variantId } = assignment as { variantId?: unknown; };
    return variantId === 1 || variantId === 2;
}

// O Logger do Vencord so aparece no console do DevTools, que ninguem abre para relatar um
// problema. Isto vai para o mesmo arquivo do processo principal, entao o registro conta a
// historia inteira num lugar so.
function record(message: string) {
    logger.info(message);
    if (typeof Native?.logFromRenderer === "function") {
        void Native.logFromRenderer(message).catch(() => {
            // Sem o registro em arquivo ainda resta o console; nao vale quebrar o fluxo por isso.
        });
    }
}
function recordRendererError(message: string, error?: unknown) {
    logger.error(message, error);
    if (typeof Native?.logFromRenderer !== "function") return;
    const detail = error instanceof Error ? error.message : error == null ? "" : String(error);
    const payload = `[error][renderer] ${message}${detail ? `: ${detail}` : ""}`;
    void Native.logFromRenderer(payload).catch(() => {
        // Sem o processo principal, o logger do Vencord continua sendo a saída local.
    });
}

// O que so o renderer enxerga. Sem isto o arquivo mostraria qual saida subiu, mas nunca se o
// servidor aceitou, que e a pergunta que importa.
function recordSession() {
    const user = UserStore.getCurrentUser();
    const assignment = user == null ? "sem usuario" : ApexExperimentStore.getServerAssignment("user", user.id, VIDEO_GUARD);

    record(`sessao aberta | atribuicao do video guard: ${JSON.stringify(assignment)}`);
    record(`  o cliente aceita video? supports ${ask(MediaEngineStore, "supports", "VIDEO")} | supportsInApp ${ask(MediaEngineStore, "supportsInApp", "VIDEO")} | desktop ${ask(MediaEngineStore, "supportsInApp", "DESKTOP_CAPTURE")}`);
    record(`  regiao preferida ${ask(RTCRegionStore, "getPreferredRegion")} | lista ${JSON.stringify(ask(RTCRegionStore, "getPreferredRegions"))} | override instalado ${original !== undefined}`);
}

function reportSession() {
    recordSession();
    if (!Native) return;

    // A conexão do gateway não muda a rota: o túnel WireGuard já nasceu antes do
    // Discord conectar e continua isolado por aplicativo. Este registro é somente
    // diagnóstico e não tenta recarregar ou trocar a saída no meio da mídia.
    Native.getVpnStatus().then(status => {
        const { goLive } = (status as PluginVpnStatus);
        record(`sessao aberta | VPN ${status.state} | ativa ${status.active} | ownership ${status.owned} | Go Live ${goLive?.state ?? "-"} | rota ${goLive?.server ?? "-"} | saida ${goLive?.country ?? "-"} | ${goLive?.latencyMs ?? "-"} ms | video bloqueado ${videoIsBlocked()}`);
        if (goLive?.state === "fallback") showToast("GoLiveBypass: no route is responding, so Discord connected on your normal network.", "failure");
        if (videoIsBlocked()) record("o servidor ainda reporta o guard de video; nenhuma troca automatica de rede foi feita");
    }).catch(error => recordRendererError("Falha ao consultar a VPN do plugin", error));
}

function ask(store: object, method: string, ...args: unknown[]) {
    const fn = (store as DiagnosticStore)[method];
    if (typeof fn !== "function") return "metodo ausente";

    try {
        return (fn as (...a: unknown[]) => unknown).apply(store, args) ?? null;
    } catch (error) {
        return `erro: ${error instanceof Error ? error.message : String(error)}`;
    }
}

function readStore(store: object, method: string) {
    const fn = (store as DiagnosticStore)[method];
    if (typeof fn !== "function") return { known: false as const, value: null };

    try {
        return { known: true as const, value: (fn as () => unknown).call(store) };
    } catch {
        return { known: false as const, value: null };
    }
}

function collectionCount(value: unknown): number | null {
    if (Array.isArray(value)) return value.length;
    if (value instanceof Set || value instanceof Map) return value.size;
    if (value !== null && typeof value === "object") {
        try {
            return Object.keys(value).length;
        } catch {
            return null;
        }
    }
    return null;
}

function observationText(value: unknown): string | null {
    if (typeof value !== "string") return null;
    const clean = value.trim().replace(/[|\r\n]+/g, "_").slice(0, 200);
    return clean || null;
}

function observationHostname(value: unknown): string | null {
    const raw = observationText(value);
    if (!raw) return null;
    try {
        return new URL(raw.includes("://") ? raw : `https://${raw}`).hostname || null;
    } catch {
        return raw;
    }
}

function readObservationText(store: object, method: string): string | null {
    const result = readStore(store, method);
    return result.known ? observationText(result.value) : null;
}

function readObservationHostname(store: object, method: string): string | null {
    const result = readStore(store, method);
    return result.known ? observationHostname(result.value) : null;
}

function configuredStreamRegion(): string | null {
    const configured = settings.store.streamRegion;
    return typeof configured === "string" && configured.trim() !== AUTOMATIC
        ? observationText(configured)
        : null;
}

// Guarda especifica para o falso "transmitindo"/erro 2001 visto no fogo da
// beta 13. Nao tenta inferir fps nem fechar sockets: as stores do renderer so
// provam que a UI afirma uma Live e se a conexao nativa de stream chegou a
// existir. Dado ausente falha fechado; a unica acao e um aviso manual.
function pollStreamClaimOnce() {
    const claimed = readStore(ApplicationStreamingStore, "getCurrentUserActiveStream");
    const visibleStreams = readStore(ApplicationStreamingStore, "getAllActiveStreams");
    const nativeKeys = readStore(StreamRTCConnectionStore, "getAllActiveStreamKeys");

    const senderClaimed = !claimed.known ? null : normalizeStreamClaim(claimed.value);
    if (senderClaimed === false) lastSelectedStreamRegion = null;
    const now = Date.now();
    const observation: StreamObservation = {
        now,
        senderClaimed,
        visibleStreamCount: visibleStreams.known ? collectionCount(visibleStreams.value) : null,
        nativeStreamCount: nativeKeys.known ? collectionCount(nativeKeys.value) : null,
        voiceState: readObservationText(RTCConnectionStore, "getState"),
        voiceHostname: readObservationHostname(RTCConnectionStore, "getHostname"),
        selectedRegion: lastSelectedStreamRegion ?? configuredStreamRegion(),
    };
    const observationDecision = evaluateStreamObservation(observation);
    lastStreamObservation = {
        status: observationDecision.status,
        visibleStreamCount: observation.visibleStreamCount,
        nativeStreamCount: observation.nativeStreamCount,
    };
    if (observationDecision.key !== lastStreamObservationKey) {
        lastStreamObservationKey = observationDecision.key;
        record(
            `stream.observation | status=${observationDecision.status}` +
            ` claimed=${observation.senderClaimed ?? "unknown"}` +
            ` visible=${observation.visibleStreamCount ?? "unknown"}` +
            ` native=${observation.nativeStreamCount ?? "unknown"}` +
            ` voice_state=${observation.voiceState ?? "unknown"}` +
            ` voice_host=${observation.voiceHostname ?? "unknown"}` +
            ` selected_region=${observation.selectedRegion ?? "automatic"}`
        );
    }

    const nativeStreamCount = nativeKeys.known ? collectionCount(nativeKeys.value) : null;
    const decision = evaluateStreamClaim({
        now, senderClaimed, nativeStreamCount
    }, streamClaimState);

    streamClaimState = decision.state;
    const previousStatus = streamClaimStatus;
    streamClaimStatus = decision.status;

    if (decision.warn) {
        record("stream.guard | UI afirma transmissao, mas nenhuma conexao nativa apareceu em 30s; possivel erro 2001, sem acao automatica");
        showToast(
            "GoLiveBypass: Discord says you're streaming, but no native Live connection appeared (possible error 2001). Stop the false Live, reload with Ctrl+R, then start it again.",
            "failure"
        );
    } else if (previousStatus.startsWith("failed") && decision.status === "healthy") {
        record("stream.guard | conexao nativa apareceu depois do aviso; estado recuperado");
    }
}

function pollStreamClaim() {
    try {
        pollStreamClaimOnce();
        streamClaimProbeFailed = false;
    } catch (error) {
        // Watchdog e diagnostico: uma mudanca de store nunca pode derrubar o
        // renderer. Registra uma vez e continua tentando nos proximos ciclos.
        if (!streamClaimProbeFailed)
            recordRendererError("Failed to inspect the native stream state", error);
        streamClaimProbeFailed = true;
    }
}

function startStreamClaimWatch() {
    if (streamClaimTimer !== null) return;
    streamClaimState = initialStreamClaimState();
    streamClaimStatus = "idle";
    streamClaimProbeFailed = false;
    lastStreamObservationKey = null;
    lastStreamObservation = null;
    lastSelectedStreamRegion = null;
    pollStreamClaim();
    streamClaimTimer = setInterval(pollStreamClaim, 5_000);
}

function stopStreamClaimWatch() {
    if (streamClaimTimer !== null) clearInterval(streamClaimTimer);
    streamClaimTimer = null;
    streamClaimState = initialStreamClaimState();
    streamClaimStatus = "idle";
    streamClaimProbeFailed = false;
    lastStreamObservationKey = null;
    lastStreamObservation = null;
    lastSelectedStreamRegion = null;
}

// Diagnóstico que só o renderer enxerga: alimenta o relato de bug (campo `session`) e,
// junto do processo principal, o texto copiado pelo comando `/golivebypass`.
function buildRendererDiagnostics() {
    const user = UserStore.getCurrentUser();
    const lines: string[] = ["GoLiveBypass, diagnostico"];

    lines.push("", "== o servidor te bloqueia? ==");
    lines.push(`atribuicao do video guard: ${JSON.stringify(user == null ? "sem usuario" : ask(ApexExperimentStore, "getServerAssignment", "user", user.id, VIDEO_GUARD))}`);

    lines.push("", "== o cliente consegue fazer video? ==");
    lines.push(`supports(VIDEO)          ${ask(MediaEngineStore, "supports", "VIDEO")}`);
    lines.push(`supportsInApp(VIDEO)     ${ask(MediaEngineStore, "supportsInApp", "VIDEO")}`);
    lines.push(`supportsInApp(DESKTOP)   ${ask(MediaEngineStore, "supportsInApp", "DESKTOP_CAPTURE")}`);
    lines.push(`motor de midia pronto    ${ask(MediaEngineStore, "isSupported")}`);

    lines.push("", "== transmissao ==");
    const observation = lastStreamObservation;
    lines.push(`observacao stream        ${observation
        ? `${observation.status} | visiveis ${observation.visibleStreamCount ?? "desconhecido"} | nativas ${observation.nativeStreamCount ?? "desconhecido"}`
        : "sem amostra"}`);
    lines.push(`estado da call           ${ask(RTCConnectionStore, "getState")} em ${ask(RTCConnectionStore, "getHostname")}`);
    lines.push(`guarda UI/conexao nativa ${streamClaimStatus}`);

    lines.push("", "== regiao ==");
    lines.push(`preferida  ${ask(RTCRegionStore, "getPreferredRegion")}`);
    lines.push(`lista      ${JSON.stringify(ask(RTCRegionStore, "getPreferredRegions"))}`);
    lines.push(`override instalado ${original !== undefined}`);

    lines.push("", "== configuracao ==");
    const { vpnMode, customConfigPath, protonUsername, protonCountry, protonFreeOnly, protonAutoPing, voiceRegion, streamRegion } = settings.store;
    lines.push(`VPN "${vpnMode}" | conf personalizada "${customConfigPath ? "definida" : "vazia"}" | usuário Proton "${protonUsername ? "definido" : "vazio"}" | países "${protonCountry}" | somente grátis ${protonFreeOnly} | auto-ping ${protonAutoPing} | região de call "${voiceRegion}" | região de stream "${streamRegion}"`);

    return lines.join("\n");
}

async function buildReport() {
    const lines: string[] = [buildRendererDiagnostics()];

    lines.push("", "== processo principal ==");
    if (!Native) {
        lines.push("indisponivel, o plugin esta rodando sem a parte desktop");
    } else {
        try {
            const status = await Native.getVpnStatus();
            lines.push(`VPN agora: ${status.state} | ativa ${status.active} | ownership ${status.owned} | geração ${status.generation}`);
            if (status.externalReason) lines.push(`motivo externo: ${status.externalReason}`);
            if (status.lastDiagnostic) lines.push(`último diagnóstico: ${status.lastDiagnostic.kind} | ok ${status.lastDiagnostic.ok} | ${status.lastDiagnostic.detail}`);
            lines.push(await Native.getLog() || "sem registros");
        } catch (error) {
            lines.push(`nao consegui falar com o processo principal: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    return lines.join("\n");
}

type BugReportPhase = "idle" | "sending" | "success" | "deduped" | "blocked" | "error";

let bugReportOpen = false;
let bugReportModalKey: string | null = null;
let bugReportModalToken = 0;

function openBugReport() {
    if (bugReportOpen) return;
    bugReportOpen = true;
    const modalToken = ++bugReportModalToken;
    try {
        const modalKey = openModal(props => <BugReportModal modalProps={props} onClosed={() => {
            if (modalToken !== bugReportModalToken) return;
            bugReportOpen = false;
            bugReportModalKey = null;
        }} />);
        if (modalToken === bugReportModalToken && bugReportOpen) bugReportModalKey = modalKey;
    } catch (error) {
        bugReportOpen = false;
        bugReportModalKey = null;
        recordRendererError("Falha ao abrir o relato de bug do GoLiveBypass", error);
    }
}

// Relato manual: nada aqui é disparado por falha, boot ou atualização. O envio é feito
// pela parte nativa, que é a única que conhece o endpoint e o token; o renderer manda
// apenas título, descrição e o diagnóstico que ele mesmo enxerga.
function BugReportModal({ modalProps, onClosed }: { modalProps: RenderModalProps; onClosed: () => void }) {
    const [phase, setPhase] = useState<BugReportPhase>("idle");
    const [title, setTitle] = useState("");
    const [description, setDescription] = useState("");
    const [includeLogs, setIncludeLogs] = useState(true);
    const [feedback, setFeedback] = useState<string | null>(null);
    const [issueUrl, setIssueUrl] = useState<string | null>(null);
    const [blockedSeconds, setBlockedSeconds] = useState(0);
    const disposedRef = React.useRef(false);
    const closedRef = React.useRef(false);
    const headingRef = React.useRef<HTMLHeadingElement | null>(null);

    const closeModal = () => {
        if (closedRef.current) return;
        closedRef.current = true;
        disposedRef.current = true;
        onClosed();
        modalProps.onClose();
    };

    useEffect(() => {
        disposedRef.current = false;
        headingRef.current?.focus({ preventScroll: true });
        return () => { disposedRef.current = true; };
    }, []);

    // Consulta inicial: o carimbo do bloqueio é do servidor, nunca um valor fixo daqui.
    useEffect(() => {
        if (!Native || typeof Native.getBugReportStatus !== "function") return;
        void Promise.resolve(Native.getBugReportStatus()).then(status => {
            if (disposedRef.current || !status?.blocked) return;
            setBlockedSeconds(status.retryAfter);
            setPhase("blocked");
        }).catch(error => recordRendererError("Falha ao consultar o bloqueio de relatos", error));
    }, []);

    useEffect(() => {
        if (phase !== "blocked") return;
        const timer = setInterval(() => setBlockedSeconds(seconds => Math.max(0, seconds - 1)), 1_000);
        return () => clearInterval(timer);
    }, [phase]);

    useEffect(() => {
        if (phase === "blocked" && blockedSeconds === 0) setPhase("idle");
    }, [phase, blockedSeconds]);

    const enviar = async () => {
        if (phase === "sending" || !title.trim()) return;
        if (!Native || typeof Native.submitBugReport !== "function") {
            setFeedback("This plugin build can't send reports. Update or reinstall it.");
            setPhase("error");
            return;
        }

        setPhase("sending");
        setFeedback(null);
        try {
            const resultado = await Native.submitBugReport({ title, description, includeLogs, session: buildRendererDiagnostics() });
            if (disposedRef.current) return;
            if (resultado?.ok) {
                // Sucesso limpa os campos; falha preserva o que o usuário escreveu.
                setTitle("");
                setDescription("");
                setIncludeLogs(true);
                setIssueUrl(resultado.issueUrl ?? null);
                setPhase(resultado.deduped ? "deduped" : "success");
                return;
            }
            if (resultado?.code === "BLOQUEADO") {
                setBlockedSeconds(resultado.retryAfter ?? 0);
                setPhase("blocked");
                return;
            }
            setFeedback(resultado?.error || "Couldn't send the report. Try again.");
            setPhase("error");
        } catch (error) {
            if (disposedRef.current) return;
            recordRendererError("Falha ao enviar o relato de bug", error);
            setFeedback("Couldn't reach the desktop part of the plugin. Copy the diagnostics and try again.");
            setPhase("error");
        }
    };

    const copiarDiagnostico = () => {
        void buildReport()
            .then(report => copyWithToast(report, "Diagnostics copied."))
            .catch(error => recordRendererError("Falha ao montar o diagnóstico do relato", error));
    };

    const enviando = phase === "sending";
    const bloqueado = phase === "blocked" && blockedSeconds > 0;
    const espera = blockedSeconds >= 60 ? `${Math.floor(blockedSeconds / 60)}min ${blockedSeconds % 60}s` : `${blockedSeconds}s`;
    const concluido = phase === "success" || phase === "deduped";
    const actions = [
        { text: "Close", variant: "secondary" as const, onClick: closeModal, disabled: enviando },
        { text: "Copy diagnostics", variant: "secondary" as const, onClick: copiarDiagnostico, disabled: enviando },
        { text: enviando ? "Sending…" : "Send", variant: "primary" as const, onClick: () => void enviar(), disabled: enviando || bloqueado || !title.trim() },
    ];

    return (
        <Modal {...modalProps} onClose={closeModal} title="Report a bug" size="md" actions={actions}>
            <div style={{ maxHeight: "min(60vh, 560px)", overflowY: "auto", overflowX: "hidden", paddingRight: "4px", minWidth: 0, display: "flex", flexDirection: "column", gap: "12px" }}>
                <h2 ref={headingRef} tabIndex={-1} style={{ margin: 0, color: "var(--header-primary)" }}>Report a GoLiveBypass problem</h2>
                {concluido ? (
                    <div style={onboardingBoxStyle} role="status" aria-live="polite">
                        <Paragraph><strong>{phase === "deduped" ? "This report was already sent recently." : "Report sent. Thanks for helping!"}</strong></Paragraph>
                        <Paragraph>The session logs were attached after redaction: no password, WireGuard key or exit route.</Paragraph>
                        {issueUrl && <Paragraph><MaskedLink href={issueUrl}>Open the issue on GitHub</MaskedLink></Paragraph>}
                    </div>
                ) : (
                    <>
                        <Paragraph>Describe the problem. The summary, details and plugin session logs go to the reports API, which opens a GitHub issue. Redaction happens before anything leaves this computer.</Paragraph>
                        <label style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                            <span>Summary</span>
                            <TextInput value={title} onChange={setTitle} maxLength={200} disabled={enviando} placeholder="e.g. Go Live still blocked with the bypass on" aria-label="Problem summary" />
                        </label>
                        <label style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                            <span>Details</span>
                            <TextArea value={description} onChange={setDescription} maxLength={8192} rows={5} disabled={enviando} placeholder="What happened? What did you expect? Steps to reproduce..." aria-label="Problem details" />
                        </label>
                        <FormSwitch title="Include session logs (recommended)" description="Plugin log and renderer diagnostics, redacted before sending." value={includeLogs} onChange={setIncludeLogs} disabled={enviando} />
                    </>
                )}
                {bloqueado && (
                    <Paragraph role="status" aria-live="polite"><strong>You sent too many reports.</strong> Try again in {espera}.</Paragraph>
                )}
                {feedback && <Paragraph role="alert" aria-live="assertive"><strong>{feedback}</strong></Paragraph>}
            </div>
        </Modal>
    );
}

export default definePlugin({
    name: "GoLiveBypass",
    description: "Turns Go Live and camera back on for Brazilian accounts, and provides an isolated WireGuard VPN for this Discord only.",
    authors: [{ name: "bezumiya", id: 1366453661970071633n }],
    tags: ["Voice", "Privacy"],
    settings,
    settingsAboutComponent: AboutPlugin,
    dependencies: ["HeaderBarAPI"],
    headerBarButton: {
        icon: PanelIconOff,
        render: ControlPanelButton,
    },
    toolboxActions: {
        "Open GoLiveBypass panel": openControlPanel,
        "Report a GoLiveBypass bug": openBugReport,
    },

    patches: [
        {
            find: "\"2026-08-video-guard\"",
            replacement: {
                match: /(?<=name:"2026-08-video-guard".{0,100}?)variations:\{.{0,120}?\}\}(?=\}\))/,
                replace: "variations:{}"
            }
        },
        {
            find: ".STREAM_CREATE,{type:",
            replacement: {
                match: /(?<=\.STREAM_CREATE,\{.{0,80}?preferred_region:)\i/,
                replace: "$self.pickStreamRegion($&)"
            }
        }
    ],

    pickStreamRegion(fallback: string | null) {
        const region = settings.store.streamRegion;
        const selected = typeof region === "string" && region !== AUTOMATIC ? region : fallback;
        lastSelectedStreamRegion = observationText(selected);
        return selected;
    },

    commands: [
        {
            name: "golivebypass",
            description: "Copies plugin diagnostics for you to paste in support.",
            async execute(_args, ctx) {
                const report = await buildReport();
                copyWithToast(report, "Diagnostics copied. Paste them in the support channel.");
                sendBotMessage(ctx.channel.id, { content: `\`\`\`\n${report.slice(0, 1800)}\n\`\`\`` });
            }
        }
    ],

    flux: {
        CONNECTION_OPEN() {
            reportSession();
        },

        LOGOUT() {
            record("voce saiu da conta; a VPN do plugin permanece isolada e nao troca a rota automaticamente");
        }
    },

    start() {
        const lifecycleGeneration = ++pluginLifecycleGeneration;
        const isLifecycleCurrent = () => lifecycleGeneration === pluginLifecycleGeneration;
        forceRegion();
        startStreamClaimWatch();

        const onboardingRequired = Native && settings.store.onboardingCompleted !== true;
        if (onboardingTimer !== null) {
            clearTimeout(onboardingTimer);
            onboardingTimer = null;
        }
        if (onboardingRequired && settings.store.onboardingSkipped !== true) {
            onboardingTimer = setTimeout(() => {
                onboardingTimer = null;
                if (settings.store.onboardingSkipped === true) return;
                if (isLifecycleCurrent() && settings.store.onboardingCompleted !== true) openControlPanel();
            }, 2_500);
        }

        const configure = Native?.configurePluginUpdates;
        if (typeof configure === "function") {
            void configure({
                enabled: settings.store.autoUpdate !== false,
                channel: normalizedUpdateChannel(settings.store.updateChannel)
            }).catch(error => {
                if (isLifecycleCurrent()) recordRendererError("Falha ao configurar o updater do plugin", error);
            });
        }

        // O aviso aparece mesmo para quem nunca abre a aba de configuração. O processo
        // principal faz a checagem/download; o renderer observa continuamente se há
        // reload pendente ou uma falha nova, inclusive depois da primeira consulta.
        schedulePluginUpdateStatusObservation(lifecycleGeneration);

        if (typeof Native?.setGoLive === "function") {
            void Promise.resolve(Native.setGoLive(settings.store.goLive === true))
                .catch(error => recordRendererError("Falha ao sincronizar o Go Live", error));
        }

        // A primeira execução precisa deixar o usuário atravessar as três etapas do
        // assistente antes de qualquer ativação que possa relançar o Discord.
        //
        // Este caminho é automático (start do renderer), então usa `enableAutomatic`: ele não
        // relança o Discord e respeita a suspensão de autostart. O relaunch ficou reservado
        // para o botão do painel (`Native.enable`), porque repeti-lo a cada boot transformava
        // um relaunch não confirmado num ciclo infinito de reinícios do Discord. Bridge antiga
        // sem `enableAutomatic` simplesmente não ativa sozinha -- o painel continua ativando.
        if (!onboardingRequired && typeof Native?.enableAutomatic === "function") {
            void Native.enableAutomatic().then(result => {
                if (!isLifecycleCurrent()) return;
                if (result?.success === false && !result.suppressed)
                    showToast(`GoLiveBypass couldn't turn on the VPN: ${result.error || result.message || "see the log"}`, "failure");
            }).catch(error => {
                if (isLifecycleCurrent()) recordRendererError("Failed to reach the desktop process", error);
            });
        }
    },

    stop() {
        dismissPluginUpdateOverlays();
        pluginLifecycleGeneration++;
        lastNotifiedPendingVersion = null;
        lastNotifiedUpdateErrorKey = null;
        lastSuppressedUpdateErrorKey = null;
        if (onboardingTimer !== null) {
            clearTimeout(onboardingTimer);
            onboardingTimer = null;
        }
        if (updateCheckTimer !== null) {
            clearTimeout(updateCheckTimer);
            updateCheckTimer = null;
        }
        if (onboardingModalKey !== null) {
            const modalKey = onboardingModalKey;
            onboardingModalToken++;
            onboardingModalKey = null;
            onboardingOpen = false;
            closeDiscordModal(modalKey);
        } else {
            onboardingModalToken++;
            onboardingOpen = false;
        }
        if (bugReportModalKey !== null) {
            const modalKey = bugReportModalKey;
            bugReportModalToken++;
            bugReportModalKey = null;
            bugReportOpen = false;
            closeDiscordModal(modalKey);
        } else {
            bugReportModalToken++;
            bugReportOpen = false;
        }
        stopStreamClaimWatch();
        restoreRegion();
        if (typeof Native?.shutdown === "function") {
            void Native.shutdown().catch(error => recordRendererError("Failed to reach the desktop process", error));
        }
    }
});
