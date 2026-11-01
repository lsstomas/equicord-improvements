/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./control-panel.css";

import { Button } from "@components/Button";
import { Switch } from "@components/Switch";
import type { RenderModalProps } from "@vencord/discord-types";
import { Modal, React, TextInput, useState } from "@webpack/common";
import type { ReactNode, RefObject } from "react";

import {
    formatProtonRoutePing,
    isProtonRouteSelectable,
    type ProtonRouteCandidate,
    protonRouteLocation,
    protonRouteStateLabel,
    protonRouteTierLabel,
    sortProtonRouteCandidates,
} from "./proton-manual-selection";
import { formatVpnRouteSummary, type VpnRouteInfo } from "./vpn-types";

export type PanelTone = "on" | "off" | "busy" | "alert";
type CheckTone = "ok" | "warn" | "idle";
type PanelTab = "route" | "account" | "advanced";

export interface PanelStatus {
    state: string;
    active: boolean;
    requiresRelaunch?: boolean;
    appsOutdated?: boolean;
    sessionStorage?: string;
    externalReason: string | null;
    dependencies?: string[];
    lastDiagnostic: { detail: string; ok?: boolean; } | null;
    route?: VpnRouteInfo | null;
}

export interface PanelSession {
    valid: boolean;
    expiresIn?: string;
    error?: string;
}

export interface ControlPanelController {
    status: PanelStatus | null;
    session: PanelSession | null;
    sessionTitle: string | null;
    customMode: boolean;
    customConfigPath: string;
    protonCountry: string;
    protonFreeOnly: boolean;
    protonAutoPing: boolean;
    username: string;
    password: string;
    twoFactorCode: string;
    passwordRef: RefObject<HTMLInputElement | null>;
    busy: boolean;
    optimizing: boolean;
    loginActive: boolean;
    loginCancelRequested: boolean;
    loginError: string | null;
    optimizationError: string | null;
    optimizationLabel: string;
    routes: ProtonRouteCandidate[];
    recommendedServer: string | null;
    discoveryActive: boolean;
    discoveryError: string | null;
    applyingServer: string | null;
    selectionError: string | null;
    activationBlockReason: string | null;
    canActivate: boolean;
    goLiveBlocked: boolean;
    setUsername(value: string): void;
    setPassword(value: string): void;
    setTwoFactorCode(value: string): void;
    setVpnMode(mode: "proton" | "custom"): void;
    setProtonCountry(value: string): void;
    setProtonFreeOnly(value: boolean): void;
    setProtonAutoPing(value: boolean): void;
    refresh(): Promise<void>;
    activate(): void;
    deactivate(): void;
    reconnect(): void;
    restartClient(): void;
    restoreNetwork(): void;
    testConfig(): void;
    selectCustomConfig(): void;
    login(): void;
    cancelLogin(): void;
    logout(): void;
    optimize(): void;
    discoverRoutes(): void;
    selectRoute(server: string): void;
    cancelRouteSelection(): void;
    copyDiagnostic(): void;
    reportBug(): void;
}

const BUSY_TITLES: Record<string, string> = {
    authorizing: "Waiting for permission…",
    preparing: "Preparing the tunnel…",
    starting: "Turning on…",
    stopping: "Turning off…",
    restart_pending: "Restart Discord to finish",
};

export function panelTone(status: Pick<PanelStatus, "state" | "active" | "requiresRelaunch" | "appsOutdated"> | null): PanelTone {
    if (!status) return "off";
    if (status.requiresRelaunch || status.appsOutdated) return "alert";
    if (status.active || status.state === "active") return "on";
    if (status.state in BUSY_TITLES) return "busy";
    if (status.state === "blocked_external" || status.state === "dependency_missing" || status.state === "recovery_required") return "alert";
    return "off";
}

function ShieldIcon({ tone, size = 24 }: { tone: PanelTone; size?: number; }) {
    return (
        <svg className={`vc-glb-icon vc-glb-icon-${tone}`} width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M12 2.5 4.5 5.4v6c0 4.7 3.1 8.1 7.5 10.1 4.4-2 7.5-5.4 7.5-10.1v-6L12 2.5Z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
            <path d="M9.2 9.6 15.4 12l-6.2 2.4V9.6Z" fill="currentColor" />
            {tone !== "off" && <circle className="vc-glb-icon-dot" cx="19" cy="5" r="3.6" />}
        </svg>
    );
}

export const PanelIconOn = (props: { height?: number; width?: number; }) => <ShieldIcon tone="on" size={props.width} />;
export const PanelIconOff = (props: { height?: number; width?: number; }) => <ShieldIcon tone="off" size={props.width} />;
export const PanelIconBusy = (props: { height?: number; width?: number; }) => <ShieldIcon tone="busy" size={props.width} />;
export const PanelIconAlert = (props: { height?: number; width?: number; }) => <ShieldIcon tone="alert" size={props.width} />;

export function panelIconFor(tone: PanelTone) {
    return { on: PanelIconOn, off: PanelIconOff, busy: PanelIconBusy, alert: PanelIconAlert }[tone];
}

export const PANEL_TONE_LABEL: Record<PanelTone, string> = {
    on: "on",
    off: "off",
    busy: "working",
    alert: "needs attention",
};

function CheckGlyph({ tone }: { tone: CheckTone; }) {
    return (
        <span className={`vc-glb-check-glyph vc-glb-check-${tone}`} aria-hidden="true">
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                {tone === "ok" && <path d="m2.5 6.3 2.4 2.4 4.6-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />}
                {tone === "warn" && <path d="M6 2.4v4.2M6 9.3v.1" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />}
                {tone === "idle" && <path d="M3 6h6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />}
            </svg>
        </span>
    );
}

function CheckRow({ tone, label, value }: { tone: CheckTone; label: string; value: string; }) {
    return (
        <li className="vc-glb-check">
            <CheckGlyph tone={tone} />
            <span className="vc-glb-check-label">{label}</span>
            <span className="vc-glb-check-value" title={value}>{value}</span>
        </li>
    );
}

// O helper da Proton devolve duração do Go ("719h59m58.59s"); ninguém lê isso em horas.
function formatExpiry(value?: string): string | null {
    const hours = /(\d+)h/.exec(value ?? "")?.[1];
    if (!hours) return null;
    const total = Number(hours);
    return total >= 48 ? `expires in ${Math.floor(total / 24)} days` : `expires in ${total} h`;
}

function heroCopy(controller: ControlPanelController, tone: PanelTone) {
    const { status, session, customMode, customConfigPath } = controller;
    const route = formatVpnRouteSummary(status?.route ?? null);

    if (!status) return { title: "Checking…", detail: "Reading the tunnel state." };
    if (status.appsOutdated) return { title: "Discord was updated", detail: "The tunnel still points to the old version, so Discord is outside it. Reconnect to fix this." };
    if (status.requiresRelaunch) return { title: "Restart Discord", detail: "The tunnel is ready, but this Discord is still outside it." };
    if (tone === "on") return { title: "Bypass is on", detail: route ? `Connected through ${route}` : "Discord is going through the tunnel." };
    if (tone === "busy") return { title: BUSY_TITLES[status.state], detail: route ? `Route ${route}` : "One moment." };
    if (status.state === "recovery_required") return { title: "Needs attention", detail: "The last cleanup wasn't confirmed. Restore the network before turning it on again." };
    if (status.state === "blocked_external") return { title: "Another tunnel is running", detail: status.externalReason || "The plugin won't take over a tunnel it didn't start." };
    if (status.state === "dependency_missing") return { title: "Missing components", detail: status.dependencies?.join(", ") || status.externalReason || "Network dependencies weren't found." };
    if (customMode) return { title: "Bypass is off", detail: customConfigPath.trim() ? "Your .conf file is ready." : "Choose a .conf file to continue." };
    if (session && !session.valid) return { title: "Bypass is off", detail: "Sign in to Proton to continue." };
    return { title: "Bypass is off", detail: route ? `Ready: ${route}` : "Prepare a route to turn it on." };
}

function PrimaryAction({ controller, openTab }: { controller: ControlPanelController; openTab(tab: PanelTab): void; }) {
    const { status, session, customMode, customConfigPath, busy, optimizing, applyingServer } = controller;
    const locked = busy || optimizing || applyingServer !== null;
    const className = "vc-glb-cta";

    if (!status) return <Button className={className} disabled>Checking…</Button>;
    if (status.appsOutdated) return <Button className={className} onClick={controller.reconnect} disabled={locked}>{busy ? "Reconnecting…" : "Reconnect bypass"}</Button>;
    if (status.active) return <Button className={className} variant="dangerSecondary" onClick={controller.deactivate} disabled={locked}>{busy ? "Turning off…" : "Turn off bypass"}</Button>;
    if (status.requiresRelaunch || status.state === "restart_pending") return <Button className={className} onClick={controller.restartClient} disabled={locked}>Restart Discord</Button>;
    if (status.state === "recovery_required") return <Button className={className} variant="dangerPrimary" onClick={controller.restoreNetwork} disabled={locked}>Restore network</Button>;
    if (customMode && !customConfigPath.trim()) return <Button className={className} onClick={controller.selectCustomConfig} disabled={locked}>Choose a .conf file</Button>;
    if (!customMode && session && !session.valid) return <Button className={className} onClick={() => openTab("account")}>Sign in to Proton</Button>;
    if (!customMode && session?.valid && !status.route?.endpoint) return <Button className={className} onClick={controller.optimize} disabled={locked}>{optimizing ? "Preparing the route…" : "Prepare the best route"}</Button>;
    return (
        <Button className={className} variant="positive" onClick={controller.activate} disabled={!controller.canActivate} title={controller.activationBlockReason ?? undefined}>
            {busy ? "Turning on…" : "Turn on bypass"}
        </Button>
    );
}

function Hero({ controller, openTab }: { controller: ControlPanelController; openTab(tab: PanelTab): void; }) {
    const tone = panelTone(controller.status);
    const { title, detail } = heroCopy(controller, tone);
    const hint = controller.status?.active
        ? "Only Discord goes through the tunnel. It stays on after you close Discord or restart your PC, until you turn it off here."
        : "Turning it on restarts Discord and leaves your call. Windows asks for permission the first time.";

    return (
        <section className={`vc-glb-hero vc-glb-hero-${tone}`} aria-label="Bypass status">
            <div className="vc-glb-hero-status" role="status" aria-live="polite">
                <span className="vc-glb-orb"><ShieldIcon tone={tone} size={28} /></span>
                <div className="vc-glb-hero-copy">
                    <h2>{title}</h2>
                    <p title={detail}>{detail}</p>
                </div>
            </div>
            <PrimaryAction controller={controller} openTab={openTab} />
            <p className="vc-glb-hint">{hint}</p>
        </section>
    );
}

function Checks({ controller }: { controller: ControlPanelController; }) {
    const { status, session, customMode, customConfigPath, goLiveBlocked } = controller;
    const [checking, setChecking] = useState(false);
    const [checkedAt, setCheckedAt] = useState<string | null>(null);
    const tone = panelTone(status);
    const route = formatVpnRouteSummary(status?.route ?? null);
    const diagnostic = status?.lastDiagnostic ?? null;
    const expiry = formatExpiry(session?.expiresIn);

    const verify = async () => {
        setChecking(true);
        try {
            await controller.refresh();
            setCheckedAt(new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
        } finally {
            setChecking(false);
        }
    };

    return (
        <section className="vc-glb-section" aria-label="Status check">
            <header className="vc-glb-section-head">
                <h3>Is everything working?</h3>
                <Button variant="secondary" size="small" onClick={() => void verify()} disabled={checking}>{checking ? "Checking…" : "Check now"}</Button>
            </header>
            <ul className="vc-glb-checks">
                <CheckRow tone={tone === "on" ? "ok" : tone === "alert" ? "warn" : "idle"} label="Tunnel" value={tone === "on" ? "On for Discord only" : tone === "busy" ? "Working" : tone === "alert" ? "Needs attention" : "Off"} />
                {customMode
                    ? <CheckRow tone={customConfigPath.trim() ? "ok" : "warn"} label="Profile" value={customConfigPath.trim() ? ".conf file imported" : "No file selected"} />
                    : <CheckRow tone={session?.valid ? "ok" : session ? "warn" : "idle"} label="Proton account" value={session?.valid ? `Signed in${expiry ? ` · ${expiry}` : ""}` : session ? (controller.sessionTitle ?? "Session invalid") : "Checking…"} />}
                <CheckRow tone={route ? "ok" : "warn"} label="Route" value={route ?? "None prepared"} />
                <CheckRow tone={goLiveBlocked ? "warn" : "ok"} label="Go Live" value={goLiveBlocked ? "Blocked by the server this session" : "Not blocked this session"} />
                <CheckRow tone={!diagnostic ? "idle" : diagnostic.ok === false ? "warn" : "ok"} label="Tunnel link" value={!diagnostic ? "Not measured yet" : diagnostic.ok === false ? diagnostic.detail : "Responding"} />
            </ul>
            <p className="vc-glb-hint">
                {checkedAt ? `Checked at ${checkedAt}. ` : ""}This shows the tunnel is running. The real test is starting Go Live in a call.
            </p>
        </section>
    );
}

function RouteRow({ candidate, controller, recommended, discoveryActive }: { candidate: ProtonRouteCandidate; controller: ControlPanelController; recommended: boolean; discoveryActive: boolean; }) {
    const selectable = isProtonRouteSelectable(candidate);
    const applying = controller.applyingServer === candidate.server;
    const inUse = controller.status?.route?.server === candidate.server;
    const exclusive = controller.optimizing || controller.discoveryActive || controller.applyingServer !== null;
    const stateLabel = protonRouteStateLabel(candidate, { discoveryActive });
    const location = protonRouteLocation(candidate);
    const tier = protonRouteTierLabel(candidate);

    return (
        <li className="vc-glb-route">
            <div className="vc-glb-route-main">
                <span className="vc-glb-route-name">
                    {candidate.server}
                    {recommended && <span className="vc-glb-tag">Recommended</span>}
                </span>
                <span className="vc-glb-route-meta">{[location, tier].filter(Boolean).join(" · ") || stateLabel}</span>
            </div>
            <span className="vc-glb-route-ping">{formatProtonRoutePing(candidate.pingMs)}</span>
            {inUse && !applying
                ? <span className="vc-glb-tag vc-glb-tag-on">{controller.status?.active ? "In use" : "Ready"}</span>
                : (
                    <Button
                        variant="secondary"
                        size="small"
                        onClick={() => applying ? controller.cancelRouteSelection() : controller.selectRoute(candidate.server)}
                        disabled={applying ? false : (!selectable || exclusive)}
                        title={selectable ? undefined : (stateLabel || "Route unavailable")}
                    >
                        {applying ? "Cancel" : "Use"}
                    </Button>
                )}
        </li>
    );
}

function RouteTab({ controller, openTab }: { controller: ControlPanelController; openTab(tab: PanelTab): void; }) {
    const { routes, session, customMode, customConfigPath, optimizing, discoveryActive, applyingServer } = controller;
    const [showUnavailable, setShowUnavailable] = useState(false);
    const ordered = React.useMemo(() => sortProtonRouteCandidates(routes), [routes]);
    const usable = ordered.filter(isProtonRouteSelectable);
    const hidden = ordered.length - usable.length;
    const visible = showUnavailable ? ordered : usable;
    const exclusive = optimizing || discoveryActive || applyingServer !== null;

    if (customMode) {
        return (
            <div className="vc-glb-stack">
                <p>{customConfigPath.trim() ? "Using your WireGuard file. No Proton account needed." : "Choose a WireGuard (.conf) file."}</p>
                <div className="vc-glb-row">
                    <Button onClick={controller.selectCustomConfig} disabled={controller.busy}>{customConfigPath.trim() ? "Change file" : "Choose file"}</Button>
                    <Button variant="secondary" onClick={controller.testConfig} disabled={controller.busy || !customConfigPath.trim()}>Test file</Button>
                </div>
            </div>
        );
    }

    if (!session?.valid) {
        return (
            <div className="vc-glb-stack">
                <p>{session ? "Sign in to Proton to see the routes." : "Checking your Proton account…"}</p>
                {session && <div className="vc-glb-row"><Button onClick={() => openTab("account")}>Go to Account</Button></div>}
            </div>
        );
    }

    return (
        <div className="vc-glb-stack">
            <div className="vc-glb-auto">
                <div>
                    <strong>Automatic route</strong>
                    <p>{controller.status?.active ? "Tests routes and keeps the best one. The bypass goes off during the test, about 2 minutes, and you may drop from your call." : "Tests routes and keeps the best one."}</p>
                </div>
                <Button onClick={controller.optimize} disabled={exclusive}>{optimizing ? "Testing…" : "Optimize"}</Button>
            </div>
            {(optimizing || discoveryActive) && (
                <div className="vc-glb-progress" role="status" aria-live="polite">
                    <span className="vc-glb-progress-bar" />
                    <span>{optimizing ? "Testing routes. This takes a couple of minutes." : "Measuring route ping…"}</span>
                </div>
            )}
            {controller.optimizationError && <p className="vc-glb-error" role="alert">{controller.optimizationError}</p>}
            {controller.discoveryError && (
                <p className="vc-glb-error" role="alert">
                    {controller.discoveryError}{" "}
                    <Button variant="link" size="small" onClick={controller.discoverRoutes} disabled={exclusive}>Try again</Button>
                </p>
            )}
            {controller.selectionError && <p className="vc-glb-error" role="alert">{controller.selectionError}</p>}
            {visible.length > 0
                ? (
                    <ul className="vc-glb-routes" aria-label="Proton routes">
                        {visible.map(candidate => (
                            <RouteRow
                                key={candidate.server}
                                candidate={candidate}
                                controller={controller}
                                recommended={candidate.server === controller.recommendedServer}
                                discoveryActive={discoveryActive}
                            />
                        ))}
                    </ul>
                )
                : !discoveryActive && <p>No routes available right now. <Button variant="secondary" size="small" onClick={controller.discoverRoutes} disabled={exclusive}>Find routes</Button></p>}
            <div className="vc-glb-routes-foot">
                <span>{usable.length} of {ordered.length} routes responded</span>
                {hidden > 0 && <Button variant="secondary" size="small" onClick={() => setShowUnavailable(value => !value)}>{showUnavailable ? "Hide unavailable" : `Show ${hidden} unavailable`}</Button>}
            </div>
        </div>
    );
}

function AccountTab({ controller }: { controller: ControlPanelController; }) {
    const { session, username, password, twoFactorCode, busy, optimizing, loginActive, loginCancelRequested, loginError, status, passwordRef } = controller;
    const locked = busy || optimizing;
    const expiry = formatExpiry(session?.expiresIn);

    if (session?.valid) {
        return (
            <div className="vc-glb-stack">
                <div className="vc-glb-account">
                    <div>
                        <strong className="vc-glb-blur" title={username}>{username}</strong>
                        <p>{expiry ? `Signed in · ${expiry}` : "Signed in"}</p>
                    </div>
                    <Button variant="secondary" onClick={controller.logout} disabled={locked || controller.applyingServer !== null}>Sign out</Button>
                </div>
            </div>
        );
    }

    return (
        <form className="vc-glb-stack" onSubmit={event => { event.preventDefault(); controller.login(); }}>
            {status?.sessionStorage === "memory-only" && <p>This computer can't save the session, so you'll sign in again after Discord restarts.</p>}
            {session && !session.valid && !loginError && <p>{controller.sessionTitle}{session.error ? ` · ${session.error}` : ""}</p>}
            <label className="vc-glb-field">
                <span>Proton username</span>
                <TextInput value={username} onChange={controller.setUsername} disabled={locked} autoComplete="username" />
            </label>
            <label className="vc-glb-field">
                <span>Password</span>
                <TextInput inputRef={passwordRef} value={password} onChange={controller.setPassword} type="password" disabled={locked} autoComplete="current-password" />
            </label>
            <label className="vc-glb-field">
                <span>2FA code, if your account has one</span>
                <TextInput value={twoFactorCode} onChange={controller.setTwoFactorCode} disabled={locked} autoComplete="one-time-code" />
            </label>
            {loginError && <p className="vc-glb-error" role="alert">{loginError}</p>}
            <div className="vc-glb-row">
                {loginActive
                    ? <Button type="button" variant="secondary" onClick={controller.cancelLogin} disabled={loginCancelRequested}>{loginCancelRequested ? "Cancelling…" : "Cancel"}</Button>
                    : <Button type="submit" disabled={locked || !username.trim() || !password}>Sign in</Button>}
            </div>
        </form>
    );
}

function ToggleRow({ label, checked, onChange, disabled }: { label: string; checked: boolean; onChange(value: boolean): void; disabled: boolean; }) {
    return (
        <div className="vc-glb-toggle">
            <span>{label}</span>
            <Switch checked={checked} onChange={onChange} disabled={disabled} />
        </div>
    );
}

function AdvancedTab({ controller, regions, updates }: { controller: ControlPanelController; regions: ReactNode; updates: ReactNode; }) {
    const { customMode, protonCountry, protonFreeOnly, protonAutoPing, busy, optimizing, applyingServer, status } = controller;
    const locked = busy || optimizing || applyingServer !== null;
    const modeLocked = Boolean(status?.active) || locked;

    return (
        <div className="vc-glb-stack">
            <div className="vc-glb-group">
                <h4>Connection</h4>
                <div className="vc-glb-segment" role="radiogroup" aria-label="Connection type">
                    <button type="button" role="radio" aria-checked={!customMode} disabled={modeLocked} onClick={() => controller.setVpnMode("proton")}>ProtonVPN</button>
                    <button type="button" role="radio" aria-checked={customMode} disabled={modeLocked} onClick={() => controller.setVpnMode("custom")}>.conf file</button>
                </div>
                {status?.active && <p className="vc-glb-hint">Turn the bypass off to change the connection type.</p>}
                {!customMode && (
                    <>
                        <div className="vc-glb-field">
                            <span>Preferred countries</span>
                            <TextInput value={protonCountry} onChange={controller.setProtonCountry} disabled={locked} placeholder="Any country (e.g. US, MX)" />
                        </div>
                        <div className="vc-glb-toggles">
                            <ToggleRow label="Free servers only" checked={protonFreeOnly} onChange={controller.setProtonFreeOnly} disabled={locked} />
                            <ToggleRow label="Prefer lowest ping" checked={protonAutoPing} onChange={controller.setProtonAutoPing} disabled={locked} />
                        </div>
                    </>
                )}
            </div>
            <div className="vc-glb-group">
                <h4>Discord regions</h4>
                {regions}
            </div>
            <div className="vc-glb-group">
                <h4>Updates</h4>
                {updates}
            </div>
            <div className="vc-glb-group">
                <h4>Troubleshooting</h4>
                <p className="vc-glb-hint">Use Restore network if the bypass won't turn off or your internet stops after turning it on.</p>
                <div className="vc-glb-row">
                    <Button variant="dangerSecondary" size="small" onClick={controller.restoreNetwork} disabled={locked}>Restore network</Button>
                    <Button variant="secondary" size="small" onClick={controller.copyDiagnostic}>Copy diagnostics</Button>
                    <Button variant="secondary" size="small" onClick={controller.reportBug}>Report a bug</Button>
                </div>
            </div>
        </div>
    );
}

const TABS: { id: PanelTab; label: string; }[] = [
    { id: "route", label: "Route" },
    { id: "account", label: "Account" },
    { id: "advanced", label: "Advanced" },
];

export function ControlPanel({ modalProps, controller, regions, updates, unavailable }: {
    modalProps: RenderModalProps;
    controller: ControlPanelController;
    regions: ReactNode;
    updates: ReactNode;
    unavailable: boolean;
}) {
    const [tab, setTab] = useState<PanelTab>("route");

    if (unavailable) {
        return (
            <Modal {...modalProps} size="md" title="GoLiveBypass">
                <div className="vc-glb-panel"><p>The desktop part of the plugin isn't available in this install.</p></div>
            </Modal>
        );
    }

    return (
        <Modal {...modalProps} size="md" title="GoLiveBypass">
            <div className="vc-glb-panel">
                <Hero controller={controller} openTab={setTab} />
                <Checks controller={controller} />
                <section className="vc-glb-section" aria-label="Settings">
                    <div className="vc-glb-tabs" role="tablist" aria-label="Bypass settings">
                        {TABS.map(({ id, label }) => (
                            <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)}>{label}</button>
                        ))}
                    </div>
                    <div role="tabpanel" className="vc-glb-tabpanel">
                        {tab === "route" && <RouteTab controller={controller} openTab={setTab} />}
                        {tab === "account" && <AccountTab controller={controller} />}
                        {tab === "advanced" && <AdvancedTab controller={controller} regions={regions} updates={updates} />}
                    </div>
                </section>
            </div>
        </Modal>
    );
}
