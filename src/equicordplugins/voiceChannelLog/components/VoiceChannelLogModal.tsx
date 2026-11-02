/*
 * Vencord, a Discord client mod
 * Copyright (c) 2023 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Button } from "@components/Button";
import { classes } from "@utils/misc";
import { Channel, RenderModalProps } from "@vencord/discord-types";
import { AccessibilityStore, Alerts, Modal, openModal, React, ScrollerThin, Select, TextInput } from "@webpack/common";

import { EVENT_GROUPS, EventGroup } from "../history";
import { clearLogs, getVcLogVersion, readLogChannels, readLogPage, releaseLogs, vcLogSubscribe } from "../logs";
import { VoiceChannelLogEntry } from "../types";
import { cl, exportLogs } from "../utils";
import { VoiceChannelLogEntryComponent } from "./VoiceChannelLogEntryComponent";

const ALL_CHANNELS = "all";
const PAGE_SIZE = 200;
const SEARCH_DELAY_MS = 200;

export function openVoiceChannelLog(channel?: Channel) {
    return openModal(props => (
        <VoiceChannelLogModal props={props} channel={channel} />
    ));
}

export function VoiceChannelLogModal({ channel, props }: { channel?: Channel; props: RenderModalProps; }) {
    const version = React.useSyncExternalStore(vcLogSubscribe, getVcLogVersion);

    const [scope, setScope] = React.useState(channel?.id ?? ALL_CHANNELS);
    const [group, setGroup] = React.useState<EventGroup>("all");
    const [query, setQuery] = React.useState("");
    const [limit, setLimit] = React.useState(PAGE_SIZE);
    const [visible, setVisible] = React.useState<VoiceChannelLogEntry[]>([]);
    const [hasMore, setHasMore] = React.useState(false);
    const [loading, setLoading] = React.useState(true);
    const [failed, setFailed] = React.useState(false);
    const [channels, setChannels] = React.useState<{ label: string; value: string; }[]>([]);

    const channelId = scope === ALL_CHANNELS ? null : scope;

    React.useEffect(() => releaseLogs, []);

    React.useEffect(() => {
        let current = true;
        setLoading(true);

        // A busca espera a digitação parar, porque pode percorrer o histórico inteiro.
        const timer = setTimeout(() => {
            readLogPage({ channelId, group, query }, limit)
                .then(page => {
                    if (!current) return;
                    setVisible(page.entries);
                    setHasMore(page.hasMore);
                    setFailed(false);
                })
                .catch(() => { if (current) setFailed(true); })
                .finally(() => { if (current) setLoading(false); });
        }, query ? SEARCH_DELAY_MS : 0);

        return () => {
            current = false;
            clearTimeout(timer);
        };
    }, [version, channelId, group, query, limit]);

    React.useEffect(() => {
        let current = true;
        readLogChannels().then(list => { if (current) setChannels(list); }).catch(() => { });
        return () => { current = false; };
    }, [version]);

    const channelOptions = React.useMemo(() => {
        const options = [...channels];
        if (channel && !options.some(option => option.value === channel.id)) {
            options.push({ label: channel.name || "This call", value: channel.id });
        }
        return [{ label: "All channels", value: ALL_CHANNELS }, ...options];
    }, [channels, channel]);

    function changeFilter<T>(setFilter: (value: T) => void) {
        return (value: T) => {
            setFilter(value);
            setLimit(PAGE_SIZE);
        };
    }

    function confirmClear() {
        const label = channelOptions.find(option => option.value === scope)?.label;

        Alerts.show({
            title: channelId ? "Clear this channel's logs?" : "Clear all logs?",
            body: <p>{channelId ? `Every saved log for ${label} will be deleted.` : "Every saved log for every channel will be deleted."} This can't be undone.</p>,
            confirmColor: "danger",
            confirmText: "Clear",
            cancelText: "Cancel",
            onConfirm() {
                void clearLogs(channelId ?? undefined);
                setScope(ALL_CHANNELS);
                setLimit(PAGE_SIZE);
            }
        });
    }

    return (
        <Modal
            {...props}
            size="lg"
            title="Voice Channel Logs"
            actions={[
                {
                    text: "Export JSON",
                    variant: "secondary",
                    disabled: !visible.length,
                    onClick: () => void exportLogs({ channelId, group, query })
                },
                {
                    text: channelId ? "Clear channel logs" : "Clear all logs",
                    variant: "dangerPrimary",
                    disabled: !visible.length,
                    onClick: confirmClear
                }
            ]}
        >
            <div className={cl("filters")}>
                <Select
                    options={channelOptions}
                    select={changeFilter(setScope)}
                    isSelected={value => value === scope}
                    serialize={String}
                />
                <Select
                    options={EVENT_GROUPS}
                    select={changeFilter(setGroup)}
                    isSelected={value => value === group}
                    serialize={String}
                />
                <TextInput
                    value={query}
                    onChange={changeFilter(setQuery)}
                    placeholder="Search users, channels or events"
                />
            </div>
            <div className={cl("count")}>
                {failed ? "Couldn't read the logs" : loading && !visible.length ? "Loading…" : `${visible.length}${hasMore ? "+" : ""} ${visible.length === 1 ? "event" : "events"}`}
            </div>
            <ScrollerThin fade className={classes(cl("scroller"), `group-spacing-${AccessibilityStore.messageGroupSpacing}`)}>
                {visible.length > 0 ? visible.map((entry, i) => {
                    const day = entry.timestamp.toDateString();

                    return (
                        <React.Fragment key={entry.id}>
                            {(i === 0 || day !== visible[i - 1].timestamp.toDateString()) && (
                                <div className={cl("date-separator")} role="separator" aria-label={day}>
                                    <span>{day}</span>
                                </div>
                            )}
                            <VoiceChannelLogEntryComponent logEntry={entry} />
                        </React.Fragment>
                    );
                }) : (
                    <div className={cl("empty")}>{loading ? "Loading…" : "No logs to display."}</div>
                )}
                {hasMore && (
                    <div className={cl("load-more")}>
                        <Button size="small" variant="secondary" onClick={() => setLimit(limit + PAGE_SIZE)}>
                            Load older logs
                        </Button>
                    </div>
                )}
            </ScrollerThin>
        </Modal>
    );
}
