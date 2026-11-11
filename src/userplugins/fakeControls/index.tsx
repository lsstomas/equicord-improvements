/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import ErrorBoundary from "@components/ErrorBoundary";
import { Devs } from "@utils/constants";
import definePlugin from "@utils/types";
import { Menu, Popout, SelectedChannelStore, useRef, useState, useStateFromStores } from "@webpack/common";
import type { ComponentType, ReactNode, Ref } from "react";

import FakeDeafen from "../fakeDeafen";
import { FakeMode, fakeStore, type ModeState } from "../fakeDeafen/state";
import FakeMedia from "../fakeMedia";
import { FakeIcon } from "./Icons";

// O mesmo componente da câmera. Sem `color` e sem classe própria, o Discord aplica a cor, o hover
// e o estado ativo que aplica aos vizinhos; com a seta, monta o botão duplo do microfone e da câmera.
// `isTrayButton` como a câmera: fora da bandeja o Discord desenha uma borda fixa no botão.
// `primaryDark` fixo: parado é igual aos vizinhos, e ligado vira o realce sutil em vez do branco.
interface CallButtonProps {
    iconComponent: ComponentType<any>;
    label: string;
    onClick(): void;
    onPopoutClick(): void;
    popoutOpen: boolean;
    caretAriaLabel: string;
    buttonRef: Ref<HTMLButtonElement>;
    isActive: boolean;
    isTrayButton: boolean;
    color: "primaryDark";
}

// O tipo do Equicord para o item ainda não traz `subtext` e o ícone, que o Discord aceita. As versões
// novas do menu leem `leadingAccessory` e ignoram `leftIcon`; vão os dois para cobrir ambas.
type CheckboxItemProps = ComponentType<{
    id: string;
    label: string;
    checked: boolean;
    disabled?: boolean;
    subtext?: string;
    leftIcon?: ComponentType<any>;
    leadingAccessory?: { type: "icon"; icon: ComponentType<any>; };
    action(): void;
}>;

const modes = [
    { id: "mute", label: "Fake Mute", toggle: FakeDeafen.toggleMute },
    { id: "deafen", label: "Fake Deafen", toggle: FakeDeafen.toggleDeafen },
    { id: "camera", label: "Fake Camera", toggle: FakeMedia.toggleCamera },
    { id: "screen", label: "Fake Screen Share", toggle: FakeMedia.toggleScreenShare }
] satisfies { id: FakeMode; label: string; toggle(): void; }[];

const icons = Object.fromEntries(modes.map(mode => [mode.id, (props: { className?: string; }) => <FakeIcon mode={mode.id} {...props} />])) as Record<FakeMode, ComponentType<any>>;

function subtext(mode: FakeMode, status: ModeState) {
    if (status.error) return status.error;
    if (status.pending) return mode === "screen" ? "Waiting for Discord. Uncheck to cancel." : "Waiting for Discord…";
    return undefined;
}

function FakeMenu({ onClose }: { onClose(): void; }) {
    const state = fakeStore(s => s);
    const voiceBusy = state.mute.pending || state.deafen.pending;
    // Lido aqui, não no carregamento do plugin: o Equicord só preenche o `Menu` depois.
    const CheckboxItem = Menu.MenuCheckboxItem as CheckboxItemProps;
    const item = (mode: typeof modes[number]) => {
        const status = state[mode.id];
        return <CheckboxItem key={mode.id} id={`vc-fake-${mode.id}`} label={mode.label}
            leftIcon={icons[mode.id]} leadingAccessory={{ type: "icon", icon: icons[mode.id] }}
            checked={status.active || status.pending} subtext={subtext(mode.id, status)}
            disabled={mode.id === "mute" || mode.id === "deafen" ? voiceBusy : false} action={() => mode.toggle()} />;
    };
    return <Menu.Menu navId="vc-fake-controls" onClose={onClose} aria-label="Fake controls">
        <Menu.MenuGroup>{modes.slice(0, 2).map(item)}</Menu.MenuGroup>
        <Menu.MenuGroup>{modes.slice(2).map(item)}</Menu.MenuGroup>
    </Menu.Menu>;
}

const SafeFakeMenu = ErrorBoundary.wrap(FakeMenu, { noop: true });

function FakeButton({ NativeCallButton }: { NativeCallButton: ComponentType<CallButtonProps>; }) {
    const ref = useRef<HTMLButtonElement>(null);
    const [open, setOpen] = useState(false);
    const state = fakeStore(s => s);
    const connected = useStateFromStores([SelectedChannelStore], () => !!SelectedChannelStore.getVoiceChannelId());
    if (!connected) return null;

    const on = modes.filter(mode => state[mode.id].active || state[mode.id].pending);
    const label = on.length ? `Fake: ${on.map(mode => mode.label.slice(5)).join(", ")}` : "Fake Controls";
    const toggle = () => setOpen(value => !value);
    return <Popout targetElementRef={ref} position="top" align="center" spacing={8} shouldShow={open}
        onRequestClose={() => setOpen(false)} animation={Popout.Animation.FADE}
        renderPopout={({ closePopout }) => <SafeFakeMenu onClose={closePopout} />}>
        {() => <NativeCallButton iconComponent={FakeIcon} label={label} onClick={toggle} onPopoutClick={toggle} popoutOpen={open}
            caretAriaLabel="Fake Controls options" buttonRef={ref} isActive={on.length > 0} isTrayButton color="primaryDark" />}
    </Popout>;
}

const SafeFakeButton = ErrorBoundary.wrap(FakeButton, { noop: true });

export default definePlugin({
    name: "FakeControls",
    description: "Brings fake voice and media modes together in one button next to your camera in a call.",
    authors: [Devs.Ven],
    tags: ["Voice", "Utility"],
    enabledByDefault: true,
    dependencies: ["FakeDeafen", "FakeMedia"],
    patches: [
        {
            find: /cameraUnavailable:\i,videoBlocked:\i=!1,hasPermission:/,
            replacement: {
                match: /return(\(0,\i.jsx\)\((\i),\{\.\.\.\i,\.\.\.\i,color:.{0,500}?onPopoutClick:\i,isTrayButton:!\i\}\))/,
                replace: "return $self.renderCallButton($1,arguments[0],$2)"
            }
        }
    ],
    renderCallButton(camera: ReactNode, props: { centerButton?: boolean; join?: boolean; }, NativeCallButton: ComponentType<CallButtonProps>) {
        return <>{camera}{props.centerButton && !props.join && <SafeFakeButton NativeCallButton={NativeCallButton} />}</>;
    }
});
