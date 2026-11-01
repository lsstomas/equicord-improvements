/*
 * Vencord, a Discord client mod
 * Copyright (c) 2023 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./VoiceChannelLogEntryComponent.css";

import { openUserProfile } from "@utils/discord";
import { User } from "@vencord/discord-types";
import { ApplicationStore, Clickable, closeAllModals, IconUtils, NavigationRouter, Tooltip, UserStore } from "@webpack/common";

import { describeEntry, getChannelLabel, getUserLabel } from "../history";
import { VoiceChannelLogEntry } from "../types";
import { cl, downloadSound, formatElapsedTime, getEmojiUrl, playSound } from "../utils";
import EventIcon from "./VoiceChannelLogEntryIcons";

function getAvatarUrl(entry: VoiceChannelLogEntry, user?: User): string {
    if (user) return user.getAvatarURL(entry.guildId);
    if (entry.avatar) return IconUtils.getUserAvatarURL({ id: entry.userId, avatar: entry.avatar } as User);
    return IconUtils.getDefaultAvatarURL(entry.userId);
}

export function VoiceChannelLogEntryComponent({ logEntry }: { logEntry: VoiceChannelLogEntry; }) {
    const user = UserStore.getUser(logEntry.userId);
    const username = user?.globalName ?? user?.username ?? getUserLabel(logEntry);
    const elapsed = formatElapsedTime(logEntry.callStartedAt ? new Date(logEntry.callStartedAt) : null, logEntry.timestamp);
    const description = describeEntry(logEntry);
    const time = logEntry.timestamp.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

    return (
        <li className={cl("entry")}>
            <div className={cl("entry-timestamp")}>
                <time className={cl("timestamp")} dateTime={logEntry.timestamp.toISOString()} title={logEntry.timestamp.toLocaleString()}>{time}</time>
                {elapsed && <span className={cl("elapsed")}>{elapsed}</span>}
            </div>
            {(logEntry.type === "activity" || logEntry.type === "activity_stop") && logEntry.applicationId ? (
                <img
                    className={cl("app-icon")}
                    src={IconUtils.getApplicationIconURL({ id: logEntry.applicationId, icon: ApplicationStore.getApplication(logEntry.applicationId)?.icon })}
                    alt={logEntry.activityName ?? "Activity"}
                />
            ) : (
                <EventIcon type={logEntry.type} />
            )}
            <Tooltip text={username}>
                {(tooltipProps: any) => (
                    <img
                        {...tooltipProps}
                        className={cl("avatar")}
                        onClick={() => openUserProfile(logEntry.userId)}
                        src={getAvatarUrl(logEntry, user)}
                        alt={username}
                    />
                )}
            </Tooltip>
            <div className={cl("content")}>
                <div className={cl("heading")}>
                    <span className={cl("username")} onClick={() => openUserProfile(logEntry.userId)}>{username}</span>
                    <span className={cl("channel")}>{getChannelLabel(logEntry)}</span>
                </div>
                {logEntry.type === "soundboard" ? (
                    <div className={cl("soundboard-info")}>
                        {logEntry.emoji && <img className={cl("soundboard-emoji")} src={getEmojiUrl(logEntry.emoji)} alt={logEntry.emoji.name} />}
                        <span className={cl("soundboard-id")}>{description}</span>
                        <div className={cl("soundboard-actions")}>
                            <Tooltip text="Play sound">
                                {tooltipProps => (
                                    <Clickable {...tooltipProps} className={cl("soundboard-action")} onClick={() => playSound(logEntry.soundId!)}>
                                        <svg width="16" height="16" viewBox="0 0 24 24"><path fill="currentColor" d="M8 5v14l11-7z" /></svg>
                                    </Clickable>
                                )}
                            </Tooltip>
                            <Tooltip text="Save sound">
                                {tooltipProps => (
                                    <Clickable {...tooltipProps} className={cl("soundboard-action")} onClick={() => downloadSound(logEntry.soundId!)}>
                                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" /></svg>
                                    </Clickable>
                                )}
                            </Tooltip>
                        </div>
                    </div>
                ) : (logEntry.type === "activity" || logEntry.type === "activity_stop") && logEntry.applicationId ? (
                    <div className={cl("soundboard-info")}>
                        <span className={cl("soundboard-id")}>{description}</span>
                        <div className={cl("soundboard-actions")}>
                            <Tooltip text="View activity">
                                {tooltipProps => (
                                    <Clickable
                                        {...tooltipProps}
                                        className={cl("soundboard-action")}
                                        onClick={() => {
                                            closeAllModals();
                                            NavigationRouter.transitionTo(`/application-directory/${logEntry.applicationId}`);
                                        }}
                                    >
                                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14L21 3" /></svg>
                                    </Clickable>
                                )}
                            </Tooltip>
                        </div>
                    </div>
                ) : (
                    <span className={cl("description")}>{description}</span>
                )}
            </div>
        </li>
    );
}
