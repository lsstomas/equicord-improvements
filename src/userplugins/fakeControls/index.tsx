/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./style.css";

import { Button } from "@components/Button";
import ErrorBoundary from "@components/ErrorBoundary";
import { Heading } from "@components/Heading";
import { Switch } from "@components/Switch";
import { Devs } from "@utils/constants";
import { classes } from "@utils/misc";
import definePlugin from "@utils/types";
import type { PopoutProps } from "@vencord/discord-types";
import { findComponentByCodeLazy, findCssClassesLazy } from "@webpack";
import { Popout, React, SelectedChannelStore, Tooltip, useEffect, useRef, useState, useStateFromStores } from "@webpack/common";
import type { ComponentType, ReactElement, ReactNode, Ref } from "react";

import FakeDeafen from "../fakeDeafen";
import { FakeMode, fakeStore } from "../fakeDeafen/state";
import FakeMedia from "../fakeMedia";
import { FakeIcon } from "./Icons";

const panelClasses = findCssClassesLazy("button", "buttonColor", "buttonContents", "buttonIcon");
const PanelButton = findComponentByCodeLazy("submittingFinishedLabel", "buttonRef") as ComponentType<{
    children: ReactNode;
    className: string;
    innerClassName: string;
    buttonRef: Ref<HTMLButtonElement>;
    fullWidth: boolean;
    onClick(): void;
    "aria-label": string;
    "aria-haspopup": "dialog";
    "aria-expanded": boolean;
    "aria-controls"?: string;
}>;

interface CallButtonProps {
    iconComponent: typeof FakeIcon;
    label: string;
    onClick(): void;
    buttonRef: Ref<HTMLButtonElement>;
    className: string;
    isActive: boolean;
    isTrayButton: boolean;
    color: string;
}

const modes = [
    { id: "mute", label: "Fake Mute", detail: "Appear muted while keeping your microphone controls.", toggle: FakeDeafen.toggleMute },
    { id: "deafen", label: "Fake Deafen", detail: "Appear deafened while continuing to hear the call.", toggle: FakeDeafen.toggleDeafen },
    { id: "camera", label: "Fake Camera", detail: "Appear on camera without capturing video.", toggle: FakeMedia.toggleCamera },
    { id: "screen", label: "Fake Screen Share", detail: "Appear to share without capturing your screen.", toggle: FakeMedia.toggleScreenShare }
] satisfies { id: FakeMode; label: string; detail: string; toggle(): void; }[];

function ActiveModes({ compact = false }: { compact?: boolean; }) {
    const state = fakeStore(s => s);
    const enabled = modes.filter(mode => state[mode.id].active || state[mode.id].pending);
    if (!enabled.length) return null;
    return <div className={classes("vc-fake-status", compact && "vc-fake-status-call")} role="status" aria-label={enabled.map(mode => `${mode.label}${state[mode.id].pending ? " pending" : " active"}`).join(", ")}>
        <span className="vc-fake-status-label">FAKE</span>
        {enabled.map(mode => <Tooltip key={mode.id} text={`${mode.label}${state[mode.id].pending ? " · Waiting for Discord" : " · Active"}`}>
            {props => <span {...props} className={classes("vc-fake-status-icon", state[mode.id].pending && "vc-fake-pending")}><FakeIcon mode={mode.id} width={14} height={14} /></span>}
        </Tooltip>)}
    </div>;
}

function FakePanel({ close, setPopoutRef, panelId }: { close(): void; setPopoutRef: PopoutProps["setPopoutRef"]; panelId: string; }) {
    const state = fakeStore(s => s);
    const connected = useStateFromStores([SelectedChannelStore], () => !!SelectedChannelStore.getVoiceChannelId());
    const id = React.useId();
    const firstSwitch = useRef<HTMLInputElement>(null);
    useEffect(() => firstSwitch.current?.focus({ preventScroll: true }), []);
    return <section id={panelId} className="vc-fake-panel" role="dialog" aria-labelledby={id + "-title"} ref={setPopoutRef}>
        <header className="vc-fake-heading">
            <span className="vc-fake-heading-icon"><FakeIcon /></span>
            <Heading tag="h3" id={id + "-title"}>Fake controls</Heading>
            <Button type="button" variant="none" size="iconOnly" onClick={close} aria-label="Close Fake controls">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
            </Button>
        </header>
        <div className="vc-fake-rows">
            {modes.map(mode => {
                const status = state[mode.id];
                const busy = mode.id === "mute" || mode.id === "deafen" ? state.mute.pending || state.deafen.pending : status.pending;
                return <div key={mode.id} className={classes("vc-fake-row", status.active && "vc-fake-row-active")}>
                    <span className="vc-fake-mode-icon"><FakeIcon mode={mode.id} /></span>
                    <div className="vc-fake-row-text">
                        <label htmlFor={id + mode.id}>{mode.label}
                            {status.active && <span className="vc-fake-active-label">Active</span>}
                            {status.pending && <span className="vc-fake-pending-label">Pending</span>}
                        </label>
                        <div id={id + mode.id + "-detail"} className="vc-fake-detail">{mode.detail}</div>
                        {status.error && <div className="vc-fake-error" role="alert">{status.error}</div>}
                        {status.pending && mode.id === "screen" && <div className="vc-fake-detail" role="status">Waiting for Discord. Toggle off to cancel.</div>}
                    </div>
                    <Switch id={id + mode.id} innerRef={mode.id === "mute" ? firstSwitch : undefined} checked={status.active || status.pending} disabled={!connected || (busy && mode.id !== "screen")}
                        aria-describedby={id + mode.id + "-detail"} onChange={() => mode.toggle()} hasIcon />
                </div>;
            })}
        </div>
        <footer className="vc-fake-footer">
            <span className="vc-fake-dot" />
            <span>{connected ? "Your real camera and screen stay off." : "Join a voice channel to use Fake controls."}<br />Fake Deafen first mutes your microphone.</span>
        </footer>
    </section>;
}

const SafeFakePanel = ErrorBoundary.wrap(FakePanel, { noop: true });

function FakeButton({ NativeCallButton }: { NativeCallButton?: ComponentType<CallButtonProps>; }) {
    const ref = useRef<HTMLButtonElement>(null);
    const [open, setOpen] = useState(false);
    const state = fakeStore(s => s);
    const connected = useStateFromStores([SelectedChannelStore], () => !!SelectedChannelStore.getVoiceChannelId());
    const active = modes.some(mode => state[mode.id].active);
    const pending = modes.some(mode => state[mode.id].pending);
    const failed = modes.some(mode => state[mode.id].error);
    const id = React.useId();
    const label = "Fake controls" + (active ? " · Active" : pending ? " · Pending" : failed ? " · Action failed" : "");
    if (!connected) return null;
    return <div className={classes("vc-fake-anchor", NativeCallButton && "vc-fake-anchor-call")}>
        <Popout targetElementRef={ref} position="top" align="right" autoInvert spacing={NativeCallButton && (active || pending) ? 38 : 8}
            shouldShow={open} onRequestClose={() => setOpen(false)} animation={Popout.Animation.FADE}
            renderPopout={({ setPopoutRef }) => <SafeFakePanel close={() => setOpen(false)} setPopoutRef={setPopoutRef} panelId={id} />}>
            {() => NativeCallButton
                ? <NativeCallButton iconComponent={FakeIcon} label={label} onClick={() => setOpen(value => !value)} buttonRef={ref}
                    className={classes("vc-fake-button", (active || pending) && "vc-fake-button-active", failed && "vc-fake-button-error")}
                    isActive={active || pending || open} isTrayButton={false} color="primaryDark" />
                : <Tooltip text={open ? null : label}>
                    {props => <PanelButton {...props} buttonRef={ref} fullWidth onClick={() => setOpen(value => !value)}
                        className={classes(panelClasses.button, panelClasses.buttonColor, "vc-fake-button", (active || pending) && "vc-fake-button-active", failed && "vc-fake-button-error")}
                        innerClassName={panelClasses.buttonContents} aria-label={label} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined}>
                        <FakeIcon className={panelClasses.buttonIcon} />
                    </PanelButton>}
                </Tooltip>}
        </Popout>
        {NativeCallButton && <ActiveModes compact />}
    </div>;
}

const SafeFakeButton = ErrorBoundary.wrap(FakeButton, { noop: true });
const PanelActions = ErrorBoundary.wrap(({ row }: { row: ReactElement<{ children: ReactNode[]; className: string; }>; }) => <>
    {React.cloneElement(row, { className: classes(row.props.className, "vc-fake-actions") }, ...row.props.children, <SafeFakeButton key="fake-controls" />)}
    <ActiveModes />
</>, { noop: true });

export default definePlugin({
    name: "FakeControls",
    description: "Brings fake voice and media modes together in your voice panel and call controls.",
    authors: [Devs.Ven],
    tags: ["Voice", "Utility"],
    enabledByDefault: true,
    dependencies: ["FakeDeafen", "FakeMedia"],
    patches: [
        {
            find: 'connectionStatusTextVariant:"body-md/medium"',
            group: true,
            replacement: [
                {
                    match: /(?<=return)\(0,\i.jsxs\)\("div",\{className:\i\.\i,children:\[(?=\(0,\i.jsx\)\(\i,\{channel:\i,enableActivities:\i,disabled:!)/,
                    replace: "$self.renderPanel($&"
                },
                {
                    match: /focusProps:\i\}\):null\]\}\)/,
                    replace: "$&)"
                }
            ]
        },
        {
            find: /cameraUnavailable:\i,videoBlocked:\i=!1,hasPermission:/,
            replacement: {
                match: /return(\(0,\i.jsx\)\((\i),\{\.\.\.\i,\.\.\.\i,color:.{0,500}?onPopoutClick:\i,isTrayButton:!\i\}\))/,
                replace: "return $self.renderCallButton($1,arguments[0],$2)"
            }
        }
    ],
    renderPanel(row: ReactElement<{ children: ReactNode[]; className: string; }>) {
        return <PanelActions row={row} />;
    },
    renderCallButton(camera: ReactNode, props: { centerButton?: boolean; join?: boolean; }, NativeCallButton: ComponentType<CallButtonProps>) {
        return <>{camera}{props.centerButton && !props.join && <SafeFakeButton NativeCallButton={NativeCallButton} />}</>;
    }
});
