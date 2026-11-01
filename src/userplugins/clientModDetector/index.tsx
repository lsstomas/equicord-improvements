/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { get, set } from "@api/DataStore";
import { definePluginSettings } from "@api/Settings";
import { debounce } from "@shared/debounce";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType } from "@utils/types";
import { User } from "@vencord/discord-types";
import { React, Tooltip, UserProfileStore, UserStore, useStateFromStores } from "@webpack/common";

import { describeSignals, getMessageSignals, hasProfileThemeCode, ModSignal } from "./signals";

const logger = new Logger("ClientModDetector");

const STORE_KEY = "ClientModDetector_signals";
const USRBG_URL = "https://usrbg.is-hardly.online/users";
const USERPFP_URL = "https://userpfp.github.io/UserPFP/source/data.json";

interface MinimalMessage {
    content?: string;
    author?: { id: string; bot?: boolean; };
    webhook_id?: string;
}

const seenSignals = new Map<string, Set<ModSignal>>();
const updaters = new Set<() => void>();
let usrbgUsers = new Set<string>();
let userpfpUsers = new Set<string>();

const saveSignals = debounce(() => {
    const data = Object.fromEntries([...seenSignals].map(([userId, signals]) => [userId, [...signals]]));
    set(STORE_KEY, data).catch(error => logger.error("Failed to save signals", error));
}, 2000);

function rerender() {
    updaters.forEach(update => update());
}

function scanMessage(message: MinimalMessage) {
    const userId = message.author?.id;
    if (!userId || message.author?.bot || message.webhook_id || userId === UserStore.getCurrentUser()?.id) return;

    const found = getMessageSignals(message.content);
    if (!found.length) return;

    const signals = seenSignals.get(userId) ?? new Set();
    const sizeBefore = signals.size;
    found.forEach(signal => signals.add(signal));
    if (signals.size === sizeBefore) return;

    seenSignals.set(userId, signals);
    saveSignals();
    rerender();
}

async function fetchUserIds(url: string, field: "users" | "avatars"): Promise<Set<string>> {
    try {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return new Set(Object.keys((await response.json())[field] ?? {}));
    } catch (error) {
        logger.warn(`Failed to load ${url}`, error);
        return new Set();
    }
}

function ModIndicator({ userId, small }: { userId: string; small?: boolean; }) {
    const [, forceUpdate] = React.useState(0);

    React.useEffect(() => {
        const update = () => forceUpdate(count => count + 1);
        updaters.add(update);
        return () => void updaters.delete(update);
    }, []);

    const bio = useStateFromStores([UserProfileStore], () => UserProfileStore.getUserProfile(userId)?.bio);

    if (userId === UserStore.getCurrentUser()?.id) return null;

    const signals = new Set(seenSignals.get(userId));
    if (hasProfileThemeCode(bio)) signals.add("profileTheme");
    if (usrbgUsers.has(userId)) signals.add("usrbg");
    if (userpfpUsers.has(userId)) signals.add("userpfp");
    if (!signals.size) return null;

    const label = describeSignals([...signals]);
    const size = small ? 16 : 18;

    return (
        <Tooltip text={label}>
            {props => (
                <svg {...props} width={size} height={size} viewBox="0 0 24 24" fill="var(--status-warning)" aria-label={label} style={{ margin: "0 2px", flexShrink: 0, verticalAlign: "middle" }}>
                    <path d="M13.8 2.5a2 2 0 0 0-3.6 0L9.6 4a8 8 0 0 0-1.8 1l-1.6-.4a2 2 0 0 0-2.2 1l-.9 1.5a2 2 0 0 0 .3 2.4l1.2 1.2a8 8 0 0 0 0 2.1L3.4 15a2 2 0 0 0-.3 2.4l.9 1.5a2 2 0 0 0 2.2 1l1.6-.4a8 8 0 0 0 1.8 1l.6 1.5a2 2 0 0 0 3.6 0l.6-1.5a8 8 0 0 0 1.8-1l1.6.4a2 2 0 0 0 2.2-1l.9-1.5a2 2 0 0 0-.3-2.4l-1.2-1.2a8 8 0 0 0 0-2.1l1.2-1.2a2 2 0 0 0 .3-2.4L20 5.6a2 2 0 0 0-2.2-1l-1.6.4a8 8 0 0 0-1.8-1l-.6-1.5ZM12 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7Z" />
                </svg>
            )}
        </Tooltip>
    );
}

const settings = definePluginSettings({
    communityLists: {
        type: OptionType.BOOLEAN,
        description: "Download the public USRBG and UserPFP lists when Discord starts. They only show that someone used a client mod at some point.",
        default: true,
        restartNeeded: true
    },
    memberList: {
        type: OptionType.BOOLEAN,
        description: "Show the indicator next to names in the member list",
        default: true
    }
});

export default definePlugin({
    name: "ClientModDetector",
    description: "Marks people who left visible traces of a modified Discord client. Most people using a mod leave no trace, so no mark proves nothing.",
    authors: [{ name: "Luis", id: 0n }],
    tags: ["Utility"],
    dependencies: ["MemberListDecoratorsAPI", "NicknameIconsAPI"],
    enabledByDefault: true,
    settings,

    flux: {
        MESSAGE_CREATE({ message, optimistic }: { message: MinimalMessage; optimistic?: boolean; }) {
            if (!optimistic) scanMessage(message);
        },

        LOAD_MESSAGES_SUCCESS({ messages }: { messages: MinimalMessage[]; }) {
            messages.forEach(scanMessage);
        }
    },

    renderMemberListDecorator: ({ user }: { user?: User; }) =>
        settings.store.memberList && user ? <ModIndicator userId={user.id} small /> : null,

    renderNicknameIcon: ({ userId }: { userId: string; }) => <ModIndicator userId={userId} />,

    async start() {
        const saved = await get<Record<string, ModSignal[]>>(STORE_KEY) ?? {};
        for (const [userId, signals] of Object.entries(saved)) seenSignals.set(userId, new Set(signals));

        if (settings.store.communityLists) {
            [usrbgUsers, userpfpUsers] = await Promise.all([
                fetchUserIds(USRBG_URL, "users"),
                fetchUserIds(USERPFP_URL, "avatars")
            ]);
        }

        rerender();
    },

    stop() {
        seenSignals.clear();
        usrbgUsers = new Set();
        userpfpUsers = new Set();
        rerender();
    }
});
