/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import definePlugin from "@utils/types";
import { MediaEngineStore, Menu, SelectedChannelStore, showToast, VoiceActions } from "@webpack/common";

import { VoiceStateService } from "./service";
import { applyOverrides, createDefaultFlags, type FakeVoiceFlags, type VoiceStateKey, type VoiceStatePayload } from "./types";

let service: VoiceStateService | null = null;
let flags: FakeVoiceFlags = createDefaultFlags();
let toggling = false;

async function handleToggle(key: VoiceStateKey): Promise<void> {
    if (toggling) return;
    toggling = true;
    try {
        const next = { ...flags, [key]: !flags[key] };
        if (key === "selfDeaf" && next.selfDeaf) {
            if (!SelectedChannelStore.getVoiceChannelId()) {
                showToast({ text: "Join a voice channel before enabling Fake Deafen.", variant: "critical" });
                return;
            }
            if (MediaEngineStore.isSelfDeaf()) {
                showToast({ text: "Turn off Discord deafen before enabling Fake Deafen.", variant: "critical" });
                return;
            }
            if (!MediaEngineStore.isSelfMute()) {
                await VoiceActions.toggleSelfMute();
                if (!MediaEngineStore.isSelfMute() || MediaEngineStore.isSelfDeaf()) {
                    showToast({ text: "Could not mute your microphone. Fake Deafen was not enabled.", variant: "critical" });
                    return;
                }
            }
        }
        if (!service?.triggerUpdate(next)) {
            showToast({ text: "FakeDeafen could not update your voice state. Join a voice channel and try again.", variant: "critical" });
            return;
        }
        flags = next;
    } catch (error) {
        console.error("[FakeDeafen] Could not change voice state:", error);
        showToast({ text: "Could not change voice state. Check your microphone and try again.", variant: "critical" });
    } finally {
        toggling = false;
    }
}

export default definePlugin({
    name: "FakeDeafen",
    description: "Pretend ur deaf while secretly listening to every bit of drama",
    authors: [{ id: 1128391811136770128n, name: "@kon" }],
    tags: ["Voice", "Privacy"],

    contextMenus: {
        "audio-device-context"(children, data) {
            if (data?.renderInputDevices) {
                children.push(
                    <Menu.MenuSeparator />,
                    <Menu.MenuCheckboxItem
                        id="fake-mute"
                        label="Fake Mute"
                        checked={flags.selfMute}
                        action={() => handleToggle("selfMute")}
                    />
                );
            }

            if (data?.renderOutputDevices) {
                children.push(
                    <Menu.MenuSeparator />,
                    <Menu.MenuCheckboxItem
                        id="fake-deafen"
                        label="Fake Deafen"
                        checked={flags.selfDeaf}
                        action={() => handleToggle("selfDeaf")}
                    />
                );
            }
        }
    },

    modifyVoiceState(voiceState: VoiceStatePayload): VoiceStatePayload {
        return applyOverrides(voiceState, flags);
    },

    patches: [
        {
            find: "voiceServerPing(){",
            replacement: [
                {
                    match: /voiceStateUpdate\((\w+)\){(.{0,10})guildId:/,
                    replace: "voiceStateUpdate($1){$1=$self.modifyVoiceState($1);$2guildId:"
                }
            ]
        }
    ],

    start() {
        flags = createDefaultFlags();
        service = new VoiceStateService();
    },

    stop() {
        if (service) {
            service.triggerUpdate(createDefaultFlags());
            service = null;
        }
        flags = createDefaultFlags();
    }
});
