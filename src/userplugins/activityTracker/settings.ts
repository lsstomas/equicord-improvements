/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { OptionType } from "@utils/types";

export const settings = definePluginSettings({
    notifyStatus: {
        type: OptionType.BOOLEAN,
        description: "Notify when a tracked person changes status",
        default: true
    },
    notifyVoice: {
        type: OptionType.BOOLEAN,
        description: "Notify when a tracked person joins or leaves a call",
        default: false
    },
    persistNotifications: {
        type: OptionType.BOOLEAN,
        description: "Keep these notifications in the notification log",
        default: false
    },
    trackTyping: {
        type: OptionType.BOOLEAN,
        description: "Record when a tracked person starts typing",
        default: true
    },
    trackReactions: {
        type: OptionType.BOOLEAN,
        description: "Record reactions added or removed by a tracked person",
        default: true
    },
    saveProfileImages: {
        type: OptionType.BOOLEAN,
        description: "Save tracked people's avatars and banners to Documents\\Equicord Logs, so old versions stay available",
        default: true
    },
    sidebarSort: {
        type: OptionType.STRING,
        description: "How the dashboard orders people",
        default: "activity",
        hidden: true
    },
    autoRefreshProfiles: {
        type: OptionType.BOOLEAN,
        description: "Load one tracked person's profile every 30 minutes, to catch bio changes without opening it. These are automated requests to Discord, so leave this off if you want no risk to your account.",
        default: false
    }
});
