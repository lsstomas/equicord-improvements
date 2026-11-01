/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { findByPropsLazy } from "@webpack";
import { ChannelStore, MediaEngineStore, SelectedChannelStore } from "@webpack/common";

import { applyOverrides, type FakeVoiceFlags } from "./types";

const Gateway = findByPropsLazy("getSocket") as {
    getSocket(): { send(op: number, data: Record<string, unknown>): void; } | undefined;
};

export class VoiceStateService {
    public static cameraOverride: ((channelId: string) => boolean) | undefined;

    public triggerUpdate(flags: FakeVoiceFlags): boolean {
        const channelId = SelectedChannelStore.getVoiceChannelId();
        if (!channelId) return false;

        const channel = ChannelStore.getChannel(channelId);
        const socket = Gateway.getSocket();
        if (!channel || !socket) return false;

        const state = applyOverrides({
            selfMute: MediaEngineStore.isSelfMute(),
            selfDeaf: MediaEngineStore.isSelfDeaf(),
            selfVideo: MediaEngineStore.isVideoEnabled() || VoiceStateService.cameraOverride?.(channelId) === true
        }, flags);

        try {
            socket.send(4, {
                guild_id: channel.guild_id ?? null,
                channel_id: channelId,
                self_mute: state.selfMute,
                self_deaf: state.selfDeaf,
                self_video: state.selfVideo
            });
            return true;
        } catch (error) {
            console.error("[FakeDeafen] Voice state update failed:", error);
            return false;
        }
    }
}
