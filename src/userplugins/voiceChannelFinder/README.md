# VoiceChannelFinder

Filter the current server's voice channels by participant, occupancy and join access. Open **Filter Voice Channels** beside the invite button in the server header.

- Search by Discord ID, username, display name or server nickname.
- Choose Any, Empty, Occupied, Full or Count. In Count, enter a minimum alone for an exact count, or add a maximum for a range.
- Matching channels are highlighted in the server's channel list. A single channel found by participant has a stronger outline.
- Turn on **Hide non-matching voice channels** to remove other voice channels and their participant previews from the list.
- **Reveal matches** opens the matching categories and scrolls to the first result. Join the call through its normal channel entry.
- **Clear** restores the list. Filters stay local to the selected server and reset when Discord restarts.

Results update when participants move or permissions change. The plugin uses channels and voice states available to your client.
