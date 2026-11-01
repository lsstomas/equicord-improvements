/*
 * Vencord, a Discord client mod
 * Copyright (c) 2023 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Button } from "@components/Button";
import { classes } from "@utils/misc";
import { Channel, RenderModalProps } from "@vencord/discord-types";
import { AccessibilityStore, Alerts, Modal, openModal, React, ScrollerThin, Select, TextInput } from "@webpack/common";

import { EVENT_GROUPS, EventGroup, filterEntries, listChannels } from "../history";
import { clearLogs, getVcLogs, vcLogSubscribe } from "../logs";
import { cl, exportLogs } from "../utils";
import { VoiceChannelLogEntryComponent } from "./VoiceChannelLogEntryComponent";

const ALL_CHANNELS = "all";
const PAGE_SIZE = 200;

export function openVoiceChannelLog(channel?: Channel) {
    return openModal(props => (
        <VoiceChannelLogModal props={props} channel={channel} />
    ));
}

export function VoiceChannelLogModal({ channel, props }: { channel?: Channel; props: RenderModalProps; }) {
    const logs = React.useSyncExternalStore(vcLogSubscribe, getVcLogs);

    const [scope, setScope] = React.useState(channel?.id ?? ALL_CHANNELS);
    const [group, setGroup] = React.useState<EventGroup>("all");
    const [query, setQuery] = React.useState("");
    const [limit, setLimit] = React.useState(PAGE_SIZE);

    const channelId = scope === ALL_CHANNELS ? null : scope;

    const matching = React.useMemo(
        () => filterEntries(logs, { channelId, group, query }),
        [logs, channelId, group, query]
    );

    const channelOptions = React.useMemo(() => {
        const channels = listChannels(logs);
        if (channel && !channels.some(option => option.value === channel.id)) {
            channels.push({ label: channel.name || "This call", value: channel.id });
        }
        return [{ label: "All channels", value: ALL_CHANNELS }, ...channels];
    }, [logs, channel]);

    const visible = matching.slice(0, limit);

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
                    disabled: !matching.length,
                    onClick: () => exportLogs(matching)
                },
                {
                    text: channelId ? "Clear channel logs" : "Clear all logs",
                    variant: "dangerPrimary",
                    disabled: !logs.length,
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
                {matching.length === 1 ? "1 event" : `${matching.length} events`}
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
                    <div className={cl("empty")}>No logs to display.</div>
                )}
                {matching.length > visible.length && (
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
