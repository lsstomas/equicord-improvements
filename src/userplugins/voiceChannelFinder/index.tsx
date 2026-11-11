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
import definePlugin from "@utils/types";
import type { PopoutProps } from "@vencord/discord-types";
import { findByPropsLazy, findStoreLazy } from "@webpack";
import { FluxDispatcher, Popout, React, SelectedGuildStore, TextInput, useRef, useState } from "@webpack/common";
import type { ComponentProps, ComponentType, ReactNode, Ref } from "react";

import { defaultFilters, filterActive, Filters, finderStore, getMatchingChannels, getRowStatus, occupationOptions, useFilters, useSidebarState, useVoiceSummaryStates } from "./finder";

const title = "Filter Voice Channels";
const listActions: { channelListScrollTo(guildId: string, channelId: string): void; } = findByPropsLazy("channelListScrollTo", "clearChannelListScrollTo");
const categoryCollapse: { isCollapsed(channelId: string): boolean; } = findStoreLazy("CategoryCollapseStore");
type SidePopoutProps = Omit<ComponentProps<typeof Popout>, "align"> & { align?: ComponentProps<typeof Popout>["align"] | "top"; };
const SidePopout = Popout as ComponentType<SidePopoutProps>;

interface PanelProps {
    guildId: string;
    close: () => void;
    setPopoutRef: PopoutProps["setPopoutRef"];
}

function FinderPanel({ guildId, close, setPopoutRef }: PanelProps) {
    const filters = useFilters(guildId);
    const sidebar = useSidebarState(guildId);
    const fieldId = React.useId();
    const invalidRange = filters.occupation === "range" && filters.minimum !== "" && filters.maximum !== ""
        && Number(filters.minimum) > Number(filters.maximum);
    const update = (change: Partial<Filters>) => finderStore.setState({ guildId, filters: { ...filters, ...change } });
    const count = sidebar?.matches.size ?? 0;

    async function revealMatches() {
        if (SelectedGuildStore.getGuildId() !== guildId) return;
        const channels = getMatchingChannels(guildId, filters);
        const first = channels[0];
        if (!first) return;
        close();
        const collapsedCategories = new Set(channels.map(channel => channel.parent_id).filter(id => id && categoryCollapse.isCollapsed(id)));
        for (const id of collapsedCategories) {
            if (SelectedGuildStore.getGuildId() !== guildId) return;
            await FluxDispatcher.dispatch({ type: "CATEGORY_EXPAND", id });
        }
        if (SelectedGuildStore.getGuildId() === guildId) listActions.channelListScrollTo(guildId, first.id);
    }

    return (
        <section className="vc-voice-finder-panel" role="dialog" aria-label={title} ref={setPopoutRef}>
            <div className="vc-voice-finder-heading">
                <Heading tag="h3">{title}</Heading>
                <Button type="button" variant="none" size="iconOnly" onClick={close} aria-label="Close voice filters">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                        <path d="m6 6 12 12M18 6 6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                    </svg>
                </Button>
            </div>
            <div className="vc-voice-finder-field">
                <label htmlFor={fieldId + "-person"}>Person</label>
                <TextInput id={fieldId + "-person"} autoFocus value={filters.person} placeholder="Name, @username, nickname or ID" onChange={person => update({ person })} />
            </div>
            <div className="vc-voice-finder-field">
                <span id={fieldId + "-occupancy"}>Occupancy</span>
                <div className="vc-voice-finder-options" role="group" aria-labelledby={fieldId + "-occupancy"}>
                    {occupationOptions.map(({ value, label }) => (
                        <Button key={value} type="button" variant={filters.occupation === value ? "primary" : "secondary"} size="min"
                            aria-pressed={filters.occupation === value} onClick={() => update({ occupation: value })}>{label}</Button>
                    ))}
                </div>
            </div>
            {filters.occupation === "range" && (
                <div className="vc-voice-finder-field">
                    <div className="vc-voice-finder-range">
                        <div className="vc-voice-finder-field">
                            <label htmlFor={fieldId + "-min"}>Minimum or exact</label>
                            <TextInput id={fieldId + "-min"} inputMode="numeric" value={filters.minimum} onChange={minimum => /^\d{0,6}$/.test(minimum) && update({ minimum })} />
                        </div>
                        <div className="vc-voice-finder-field">
                            <label htmlFor={fieldId + "-max"}>Maximum (optional)</label>
                            <TextInput id={fieldId + "-max"} inputMode="numeric" value={filters.maximum} onChange={maximum => /^\d{0,6}$/.test(maximum) && update({ maximum })} />
                        </div>
                    </div>
                    {invalidRange && <div className="vc-voice-finder-error" role="alert">Maximum must be at least the minimum.</div>}
                </div>
            )}
            <div className="vc-voice-finder-toggles">
                <div className="vc-voice-finder-toggle">
                    <label htmlFor={fieldId + "-joinable"}>Only channels I can join</label>
                    <Switch id={fieldId + "-joinable"} checked={filters.joinable} onChange={joinable => update({ joinable })} />
                </div>
                <div className="vc-voice-finder-toggle">
                    <label htmlFor={fieldId + "-only"}>Hide non-matching voice channels</label>
                    <Switch id={fieldId + "-only"} checked={filters.onlyResults} onChange={onlyResults => update({ onlyResults })} />
                </div>
            </div>
            {sidebar && (
                <div className="vc-voice-finder-footer">
                    <span role="status">{count ? count + (count === 1 ? " match" : " matches") : "No matches"}</span>
                    <Button type="button" size="min" variant="none" onClick={() => finderStore.setState({ guildId, filters: defaultFilters })}>Clear</Button>
                    <Button type="button" size="min" variant="secondary" disabled={!count} onClick={revealMatches}>Reveal matches</Button>
                </div>
            )}
        </section>
    );
}

const SafeFinderPanel = ErrorBoundary.wrap(FinderPanel, { noop: true });

interface FilterButtonProps {
    guildId: string;
    NativeButton: ComponentType<{
        className: string;
        innerRef: Ref<HTMLElement>;
        onClick(): void;
        "aria-label": string;
        "aria-controls": string;
        "aria-expanded": boolean;
        "aria-haspopup": "dialog";
        children: ReactNode;
    }>;
    NativeTooltip: ComponentType<{
        text: string;
        position: "bottom";
        asContainer: boolean;
        ariaHidden: boolean;
        shouldShow: boolean;
        children: ReactNode;
    }>;
    buttonClassName: string;
}

const FilterButton = ErrorBoundary.wrap(function FilterButton({ guildId, NativeButton, NativeTooltip, buttonClassName }: FilterButtonProps) {
    const filters = useFilters(guildId);
    const ref = useRef<HTMLElement>(null);
    const [open, setOpen] = useState(false);
    const close = () => setOpen(false);

    return (
        <SidePopout
            targetElementRef={ref}
            position="right"
            align="top"
            autoInvert
            nudgeAlignIntoViewport
            spacing={10}
            shouldShow={open}
            onRequestClose={close}
            renderPopout={({ setPopoutRef }) => <SafeFinderPanel guildId={guildId} close={close} setPopoutRef={setPopoutRef} />}
        >
            {({ "aria-controls": controls, "aria-expanded": expanded }) => (
                <NativeTooltip text={title} position="bottom" asContainer ariaHidden shouldShow={!open}>
                    <NativeButton
                        innerRef={ref}
                        className={buttonClassName + (filterActive(filters) ? " vc-voice-finder-active" : "")}
                        aria-label={title}
                        aria-controls={controls}
                        aria-expanded={expanded}
                        aria-haspopup="dialog"
                        onClick={() => setOpen(value => !value)}
                    >
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                            <path d="M4 6h16M7 12h10m-7 6h4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                        </svg>
                    </NativeButton>
                </NativeTooltip>
            )}
        </SidePopout>
    );
}, { noop: true });

export default definePlugin({
    name: "VoiceChannelFinder",
    description: "Finds and filters voice channels in the current server by participant, occupancy and access.",
    authors: [Devs.Ven],
    patches: [
        {
            find: "favorite-guild-header-add-context",
            replacement: {
                match: /(!\(0,\i\.\i\)\((\i)\.id\)&&\2\.id!==\i\.\i&&)(\(0,\i\.jsx\)\((\i\.\i),\{text:.{0,100}?,position:"bottom",asContainer:!0,ariaHidden:!0,children:\(0,\i\.jsx\)\((\i\.\i),\{"aria-label":.{0,100}?,className:(\i\.\i),onClick:.{0,260}?\}\)\}\))(?=,\2\.id===)/,
                replace: "$1$self.renderHeaderActions($2.id,$4,$5,$6,$3)",
            },
        },
        {
            find: "testShouldSkipTutorial=",
            group: true,
            replacement: [
                {
                    match: /(\}\}let \i=\i=>\{let\{guildId:(\i),selectedChannelId:\i,selectedVoiceChannelId:\i\}=(\i),)/,
                    replace: "$1vcVoiceFinder=$self.useSidebarState($2),vcVoiceFinderSummary=$self.useVoiceSummaryStates($3.voiceStates,vcVoiceFinder),",
                },
                {
                    match: /(?<=\{\.\.\.\i,)listNavigator:\i,ref:\i,selectedChannel:/,
                    replace: "vcVoiceFinder,vcVoiceFinderSummary,$&",
                },
                {
                    match: /(?<=getRowHeight=.{0,550}?let\{channel:(\i),category:\i\}=\i;)(?=if\()/,
                    replace: (_, channel) => `if($self.getRowStatus(${channel}.record,this.props.vcVoiceFinder)==="hidden")return 0;`,
                },
                {
                    match: /(?<=\b\i=`\$\{\i\}\$\{\i\.id\}`;)(?=switch\((\i)\.type\)\{case)/,
                    replace: (_, channel) => `let vcVoiceFinderRow=$self.getRowStatus(${channel},this.props.vcVoiceFinder);if(vcVoiceFinderRow==="hidden")return null;`,
                },
                {
                    match: /case \i\.\i\.GUILD_(?:STAGE_)?VOICE:return\(0,\i\.jsx\)\(\i,\{channel:\i,/g,
                    replace: "$&vcVoiceFinderRow,",
                },
                {
                    match: /(?<=getSectionFooterHeight=\i=>\{let\{guildChannels:\i,)voiceStates:(\i)/,
                    replace: "vcVoiceFinderSummary:$1",
                },
                {
                    match: /(?<=renderSectionFooter=\i=>\{let\{section:\i\}=\i,\{guildChannels:\i,guildChannelsVersion:\i,)voiceStates:(\i)/,
                    replace: "vcVoiceFinderSummary:$1",
                },
                {
                    match: /(?<=rowHeight:|renderRow:|footerHeight:)(this\.(?:getRowHeight|renderRow|getSectionFooterHeight))/g,
                    replace: "this.props.vcVoiceFinder?$1.bind(this):$1",
                },
            ],
        },
        {
            find: "VoiceChannel.renderPopout: There must always be something to render",
            replacement: {
                match: /\(0,\i\.jsxs\)\("li",\{(?=(?:ref:this\.ref,)?className:\i\(\)\(this\.getModeClass\(\))/g,
                replace: '$&"data-vc-voice-finder-row":this.props.vcVoiceFinderRow,',
            },
        },
    ],
    getRowStatus,
    useSidebarState,
    useVoiceSummaryStates,
    renderHeaderActions(guildId: string, NativeTooltip: FilterButtonProps["NativeTooltip"], NativeButton: FilterButtonProps["NativeButton"], buttonClassName: string, invite: ReactNode) {
        return (
            <div className="vc-voice-finder-header-actions">
                <FilterButton key={guildId} guildId={guildId} NativeButton={NativeButton} NativeTooltip={NativeTooltip} buttonClassName={buttonClassName} />
                {invite}
            </div>
        );
    },
});
