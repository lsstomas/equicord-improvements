/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { addContextMenuPatch, NavContextMenuPatchCallback, removeContextMenuPatch } from "@api/ContextMenu";
import { HeaderBarButton } from "@api/HeaderBar";
import { showNotification } from "@api/Notifications";
import { Settings } from "@api/Settings";
import { fetchUserProfile } from "@utils/discord";
import definePlugin from "@utils/types";
import { ChannelStore, FluxDispatcher, GuildMemberStore, GuildStore, Menu, MessageStore, openModal, UserProfileStore, UserStore, VoiceStateStore } from "@webpack/common";

import { getVoiceFlags, toPreviousState } from "../../equicordplugins/voiceChannelLog/voiceEvents";
import { createChatTracker } from "./chatTracking";
import { imageUrl, mergeProfile, ProfileSnapshot } from "./profileTracking";
import { settings } from "./settings";
import { addLog, archiveHistory, flushSave, history, knownMessages, lastKnownStatus, loadState, profiles, saveNow, saveProfileImage, scheduleSave, setTracked, trackedUserIds, voiceBaseline } from "./store";
import { ActivityLog, Place, ProfileChange } from "./types";
import { ActivityDashboard, RadarIcon } from "./ui/Dashboard";
import { getContactChanges, getTrackedVoiceUpdate, VoicePeer } from "./voiceTracking";

const ARCHIVE_CHECK_MS = 6 * 60 * 60 * 1000;
const VOICE_CHECK_MS = 30_000;
const PROFILE_CHECK_MS = 5 * 60 * 1000;
const PROFILE_REFRESH_MS = 30 * 60 * 1000;
const PROFILE_SETTLE_MS = 1500;
const TYPING_REPEAT_MS = 60_000;
const CHAT_GAP_MS = 2 * 60 * 1000;
const CHAT_MIN_TURNS = 4;
const MAX_MESSAGE_CONTENT = 2000;

const lastKnownActivities = new Map<string, string>();
const processedMessageIds = new Set<string>();
const lastTyping = new Map<string, number>();
const missingFromVoice = new Set<string>();
const profileChecks = new Map<string, ReturnType<typeof setTimeout>>();
let refreshIndex = 0;
let timers: ReturnType<typeof setInterval>[] = [];

const isTracked = (userId?: string | null) => !!userId && trackedUserIds.has(userId);

function getPlace(channelId: string | null | undefined, guildId?: string | null): Place {
    const id = channelId ?? "unknown";
    const channel = channelId ? ChannelStore.getChannel(channelId) : undefined;
    const resolvedGuildId = guildId ?? channel?.guild_id ?? undefined;

    return {
        channelId: id,
        channelName: channel?.name || (channel ? "Direct message" : `Unknown channel ${id}`),
        guildId: resolvedGuildId,
        guildName: resolvedGuildId ? GuildStore.getGuild(resolvedGuildId)?.name ?? `Unknown server ${resolvedGuildId}` : undefined
    };
}

function getUsername(userId: string, fallback?: string) {
    return UserStore.getUser(userId)?.username ?? fallback ?? userId;
}

function logFor(userId: string, type: ActivityLog["type"], fields: Partial<ActivityLog>, username?: string) {
    addLog({ userId, username: getUsername(userId, username), timestamp: Date.now(), type, ...fields });
}

function shouldBeNative() {
    if (typeof Notification === "undefined") return false;

    const { useNative } = Settings.notifications;
    return useNative === "always" || (useNative === "not-focused" && !document.hasFocus());
}

function notify(title: string, body: string, userId: string) {
    showNotification({
        title: shouldBeNative() ? title : "Activity Tracker",
        body,
        icon: UserStore.getUser(userId)?.getAvatarURL(void 0, 80, true),
        noPersist: !settings.store.persistNotifications
    });
}

function getChannelPeers(channelId: string, userId: string): VoicePeer[] {
    return Object.keys(VoiceStateStore.getVoiceStatesForChannel(channelId))
        .filter(id => id !== userId)
        .map(id => ({ id, name: getUsername(id) }));
}

/** Records one tracked user's new voice state, whether an event or a check found it. */
function applyVoiceState(userId: string, raw: Parameters<typeof toPreviousState>[0] & { guildId?: string; }, oldChannelId?: string | null, detected?: boolean) {
    const next = toPreviousState(raw);
    const previous = voiceBaseline.get(userId);
    const { action, changes } = getTrackedVoiceUpdate(previous, next, oldChannelId);

    for (const { type, channelId, enabled } of changes) {
        logFor(userId, "voiceState", { voiceState: { ...getPlace(channelId, raw.guildId), change: type, enabled: !!enabled } });
    }

    if (action) {
        const place = getPlace(next.channelId ?? previous?.channelId ?? oldChannelId, raw.guildId);

        logFor(userId, "voice", {
            voiceChannel: {
                ...place,
                action,
                present: next.channelId ? getChannelPeers(next.channelId, userId) : undefined,
                flags: next.channelId ? getVoiceFlags(next) : undefined,
                detected
            }
        });

        if (settings.store.notifyVoice && action !== "move") {
            const name = getUsername(userId);
            const verb = action === "join" ? "joined" : "left";
            notify(`${name} ${verb} a call`, `${name} ${verb} #${place.channelName}${place.guildName ? ` in ${place.guildName}` : ""}`, userId);
        }
    }

    if (next.channelId) voiceBaseline.set(userId, next);
    else voiceBaseline.delete(userId);
    scheduleSave();
}

function recordContacts(state: { userId: string; channelId?: string | null; oldChannelId?: string | null; guildId?: string; }) {
    const tracked = [...voiceBaseline]
        .filter(([id]) => isTracked(id))
        .map(([id, baseline]): [string, string | undefined] => [id, baseline.channelId]);

    for (const { trackedId, action, channelId } of getContactChanges(tracked, state.userId, state.oldChannelId ?? null, state.channelId ?? null)) {
        logFor(trackedId, "contact", {
            contact: { ...getPlace(channelId, state.guildId), action, userId: state.userId, name: getUsername(state.userId) }
        });
    }
}

/** Catches what events can miss: calls in progress when tracking starts, and leaves while Discord was closed. */
function checkVoiceStates() {
    for (const userId of trackedUserIds) {
        const state = VoiceStateStore.getVoiceStateForUser(userId);
        const known = voiceBaseline.get(userId);
        const channelId = state?.channelId ?? undefined;

        if (channelId === known?.channelId) {
            missingFromVoice.delete(userId);
            continue;
        }

        // Voice states are briefly empty while reconnecting, so a leave has to be seen twice.
        if (!channelId && !missingFromVoice.has(userId)) {
            missingFromVoice.add(userId);
            continue;
        }

        missingFromVoice.delete(userId);
        applyVoiceState(userId, state ?? { ...known!, channelId: null }, known?.channelId, true);
    }
}

const chats = createChatTracker({
    gapMs: CHAT_GAP_MS,
    minTurns: CHAT_MIN_TURNS,
    isTracked,
    onSession({ trackedId, trackedName, otherId, otherName, channelId, startedAt, endedAt, turns }) {
        logFor(trackedId, "chat", {
            timestamp: endedAt,
            chat: { ...getPlace(channelId), userId: otherId, name: otherName, startedAt, endedAt, turns }
        }, trackedName);
    }
});

function readProfile(userId: string): ProfileSnapshot | null {
    const user = UserStore.getUser(userId) as any;
    if (!user) return null;

    const profile = UserProfileStore.getUserProfile(userId) as any;
    const nicks: Record<string, string | null> = {};

    for (const guildId of Object.keys(GuildStore.getGuilds())) {
        if (GuildMemberStore.isMember(guildId, userId)) nicks[guildId] = GuildMemberStore.getNick(guildId, userId);
    }

    return {
        username: user.username,
        globalName: user.globalName ?? null,
        avatar: user.avatar ?? null,
        banner: profile?.banner ?? user.banner,
        bio: profile?.bio,
        pronouns: profile?.pronouns,
        avatarDecoration: user.avatarDecorationData?.asset ?? null,
        nicks
    };
}

function saveImages(userId: string, changes: ProfileChange[], snapshot: ProfileSnapshot, first: boolean) {
    if (!settings.store.saveProfileImages) return;

    for (const kind of ["avatar", "banner"] as const) {
        const hash = snapshot[kind];
        if (hash && (first || changes.some(change => change.field === kind))) saveProfileImage(userId, kind, hash, imageUrl(kind, userId, hash));
    }
}

function checkProfile(userId: string) {
    const current = readProfile(userId);
    if (!isTracked(userId) || !current) return;

    const previous = profiles.get(userId);
    const { snapshot, changes } = mergeProfile(previous, current);

    if (previous && !changes.length) {
        profiles.set(userId, snapshot);
        return;
    }

    const named = changes.map(change => change.guildId ? { ...change, guildName: GuildStore.getGuild(change.guildId)?.name } : change);

    profiles.set(userId, snapshot);
    logFor(userId, "profile", { profile: { first: !previous, changes: named } });
    saveImages(userId, changes, snapshot, !previous);
}

/** Discord's stores update around these events, so reading them has to wait a moment. */
function scheduleProfileCheck(userId: string) {
    if (!isTracked(userId)) return;

    clearTimeout(profileChecks.get(userId));
    profileChecks.set(userId, setTimeout(() => {
        profileChecks.delete(userId);
        checkProfile(userId);
    }, PROFILE_SETTLE_MS));
}

function checkAllProfiles() {
    trackedUserIds.forEach(checkProfile);
}

function refreshNextProfile() {
    if (!settings.store.autoRefreshProfiles || !trackedUserIds.size) return;

    const userIds = [...trackedUserIds];
    const userId = userIds[refreshIndex++ % userIds.length];
    fetchUserProfile(userId).then(() => scheduleProfileCheck(userId)).catch(() => { });
}

function handlePresenceUpdates(data: { updates?: any[]; }) {
    for (const update of data.updates ?? []) {
        const userId = update?.user?.id;
        if (!isTracked(userId)) continue;

        scheduleProfileCheck(userId);

        const { status } = update;
        const previousStatus = lastKnownStatus.get(userId);

        if (status && status !== previousStatus && update.clientStatus) {
            lastKnownStatus.set(userId, status);
            logFor(userId, "status", { status: { status, clientStatus: update.clientStatus } });

            if (settings.store.notifyStatus && previousStatus) {
                const name = getUsername(userId);
                notify(`${name} changed status`, `${name} is now ${status}`, userId);
            }
        }

        // Discord repeats identical activities, so only a different set counts as a change.
        const activities = update.activities ?? [];
        const signature = activities
            .map((activity: any) => `${activity.type}:${activity.name ?? ""}:${activity.state ?? ""}:${activity.details ?? ""}:${activity.timestamps?.start ?? ""}`)
            .join("|");

        // An empty list matters too, because it's how a game ending shows up.
        if (signature !== (lastKnownActivities.get(userId) ?? "")) {
            lastKnownActivities.set(userId, signature);
            logFor(userId, "activity", { activities });
        }
    }
}

function handleVoiceStateUpdate({ voiceStates }: { voiceStates?: any[]; }) {
    voiceStates?.forEach(state => {
        recordContacts(state);
        if (isTracked(state.userId)) applyVoiceState(state.userId, state, state.oldChannelId);
    });
}

function handleMessageCreate({ message, optimistic }: { message?: any; optimistic?: boolean; }) {
    const authorId = message?.author?.id;
    if (!authorId || optimistic || message.author.bot) return;

    const { username } = message.author;
    const replyAuthor = message.referenced_message?.author;
    const mentions: any[] = message.mentions ?? [];

    chats.observe(
        message.channel_id,
        { id: authorId, name: username },
        Date.now(),
        [...mentions.map(user => user.id), ...(replyAuthor ? [replyAuthor.id] : [])]
    );

    if (!isTracked(authorId) || processedMessageIds.has(message.id)) return;

    processedMessageIds.add(message.id);
    if (processedMessageIds.size > 1000) {
        const recent = [...processedMessageIds].slice(-500);
        processedMessageIds.clear();
        recent.forEach(id => processedMessageIds.add(id));
    }

    scheduleProfileCheck(authorId);

    logFor(authorId, "message", {
        message: {
            ...getPlace(message.channel_id, message.guild_id),
            id: message.id,
            content: (message.content ?? "").slice(0, MAX_MESSAGE_CONTENT),
            attachments: message.attachments?.length || undefined,
            replyTo: replyAuthor?.username,
            mentions: mentions.length ? mentions.map(user => user.username) : undefined
        }
    }, username);
}

function handleMessageUpdate({ message }: { message?: any; }) {
    if (!message?.id || message.content === undefined) return;

    const known = knownMessages.get(message.id);
    const userId = message.author?.id ?? known?.userId;
    if (!isTracked(userId)) return;

    // Embeds loading also send updates, and those don't change the text.
    if (known ? known.content === message.content : !message.edited_timestamp) return;

    const after = message.content.slice(0, MAX_MESSAGE_CONTENT);
    logFor(userId, "messageEdit", {
        messageEdit: { ...getPlace(message.channel_id, message.guild_id), id: message.id, before: known?.content, after }
    }, message.author?.username);

    knownMessages.set(message.id, { userId, username: known?.username ?? message.author?.username ?? userId, content: after });
}

function recordDelete(id: string, channelId: string, guildId?: string) {
    const known = knownMessages.get(id);
    const stored = known ? undefined : MessageStore.getMessage(channelId, id);
    const userId = known?.userId ?? stored?.author?.id;
    if (!isTracked(userId)) return;

    logFor(userId!, "messageDelete", {
        messageDelete: { ...getPlace(channelId, guildId), id, content: known?.content ?? stored?.content }
    });
    knownMessages.delete(id);
}

function handleMessageDelete({ id, channelId, guildId }: { id: string; channelId: string; guildId?: string; }) {
    recordDelete(id, channelId, guildId);
}

function handleMessageDeleteBulk({ ids, channelId, guildId }: { ids: string[]; channelId: string; guildId?: string; }) {
    ids.forEach(id => recordDelete(id, channelId, guildId));
}

function logReaction(event: any, added: boolean) {
    if (!settings.store.trackReactions || event.optimistic || !isTracked(event.userId)) return;

    const target = MessageStore.getMessage(event.channelId, event.messageId);
    logFor(event.userId, "reaction", {
        reaction: {
            ...getPlace(event.channelId, event.guildId),
            added,
            emoji: event.emoji?.id ? `:${event.emoji.name}:` : event.emoji?.name ?? "?",
            messageId: event.messageId,
            targetAuthor: target?.author?.username,
            targetContent: target?.content?.slice(0, 200)
        }
    });
}

const handleReactionAdd = (event: any) => logReaction(event, true);
const handleReactionRemove = (event: any) => logReaction(event, false);

function handleTyping({ userId, channelId, guildId }: { userId: string; channelId: string; guildId?: string; }) {
    if (!settings.store.trackTyping || !isTracked(userId)) return;

    const key = `${userId}:${channelId}`;
    const now = Date.now();
    const isNewBurst = now - (lastTyping.get(key) ?? 0) > TYPING_REPEAT_MS;
    lastTyping.set(key, now);

    if (isNewBurst) logFor(userId, "typing", { typing: getPlace(channelId, guildId) });
}

function handleProfileEvent(event: any) {
    const userId = event.user?.id ?? event.userId;
    if (userId) scheduleProfileCheck(userId);
}

const FLUX_HANDLERS: Record<string, (event: any) => void> = {
    PRESENCE_UPDATES: handlePresenceUpdates,
    VOICE_STATE_UPDATES: handleVoiceStateUpdate,
    MESSAGE_CREATE: handleMessageCreate,
    MESSAGE_UPDATE: handleMessageUpdate,
    MESSAGE_DELETE: handleMessageDelete,
    MESSAGE_DELETE_BULK: handleMessageDeleteBulk,
    MESSAGE_REACTION_ADD: handleReactionAdd,
    MESSAGE_REACTION_REMOVE: handleReactionRemove,
    TYPING_START: handleTyping,
    GUILD_MEMBER_UPDATE: handleProfileEvent,
    USER_PROFILE_FETCH_SUCCESS: handleProfileEvent
};

function openDashboard(userId?: string) {
    openModal(modalProps => <ActivityDashboard modalProps={modalProps} initialUserId={userId} />);
}

const userContextMenuPatch: NavContextMenuPatchCallback = (children, props) => {
    const userId = props?.user?.id;
    if (!userId) return;

    children.push(
        <Menu.MenuItem id="activity-tracker-dashboard" label="Open in Activity Tracker" action={() => openDashboard(userId)} />,
        <Menu.MenuItem
            id="activity-tracker-toggle"
            label={isTracked(userId) ? "Stop Tracking User" : "Start Tracking User"}
            action={() => {
                setTracked(userId, !isTracked(userId));
                if (isTracked(userId)) checkProfile(userId);
            }}
        />
    );
};

function OpenDashboardButton() {
    return <HeaderBarButton onClick={() => openDashboard()} tooltip="Activity Tracker" icon={RadarIcon} />;
}

export default definePlugin({
    name: "ActivityTracker",
    description: "Records what the people you choose do on Discord, from everything your client receives, in a private dashboard.",
    authors: [{ name: "Elioflex", id: 0n }],
    dependencies: ["HeaderBarAPI"],
    settings,

    headerBarButton: {
        icon: RadarIcon,
        render: OpenDashboardButton
    },

    start() {
        void loadState().then(archiveHistory).catch(error => console.error("[ActivityTracker] Failed to load data:", error));

        Object.entries(FLUX_HANDLERS).forEach(([event, handler]) => FluxDispatcher.subscribe(event, handler));
        addContextMenuPatch("user-context", userContextMenuPatch);
        window.addEventListener("beforeunload", flushSave);

        timers = [
            setInterval(archiveHistory, ARCHIVE_CHECK_MS),
            setInterval(() => {
                checkVoiceStates();
                chats.sweep(Date.now());
            }, VOICE_CHECK_MS),
            setInterval(checkAllProfiles, PROFILE_CHECK_MS),
            setInterval(refreshNextProfile, PROFILE_REFRESH_MS)
        ];
    },

    stop() {
        timers.forEach(clearInterval);
        timers = [];
        profileChecks.forEach(clearTimeout);
        profileChecks.clear();
        chats.sweep(Infinity);
        flushSave();
        saveNow();

        Object.entries(FLUX_HANDLERS).forEach(([event, handler]) => FluxDispatcher.unsubscribe(event, handler));
        removeContextMenuPatch("user-context", userContextMenuPatch);
        window.removeEventListener("beforeunload", flushSave);
    },

    handleVoiceStateUpdate,
    handleMessageCreate,
    handleMessageUpdate,
    handleMessageDelete,
    handleMessageDeleteBulk,
    handleReactionAdd,
    handleTyping,
    handlePresenceUpdates,
    checkVoiceStates,
    sweepChats: chats.sweep,
    openDashboard,
    trackUser: (userId: string) => setTracked(userId, true),
    untrackUser: (userId: string) => setTracked(userId, false),
    getTrackedUsers: () => [...trackedUserIds],
    getActivityLogs: (userId?: string) => userId ? history.getEntries().filter(log => log.userId === userId) : history.getEntries(),
    exportLogs: () => JSON.stringify(history.getEntries(), null, 2)
});
