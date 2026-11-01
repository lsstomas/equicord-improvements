# VoiceChannelLog

Logs voice channel activity including joins, leaves, soundboard, mute, camera, screenshare, and more.

## What gets recorded

Only the voice channel or call you are connected to is recorded, and only while you are in it. Each log keeps the time down to the second, the user, the channel and the server.

- Who was already in the channel when you joined, and their state at that moment
- Joins, leaves and moves between channels, including your own
- Mute and deafen, both self-applied and applied by the server
- Camera and screenshare starting or stopping
- Soundboard sounds and activities

Self mute and deafen are recorded by the **Log when users mute or deafen themselves** setting.

## Viewing the logs

Open the logs from the button in the top bar, from **View Voice Channel Logs** in a channel's right-click menu, or from the Equicord Toolbox. The button also works outside of a call, where it opens every channel.

The window filters by channel and event type, searches users, channels and events, shows the newest logs first and exports the current results as JSON.

## Storage

Logs are saved in this device's browser storage, separately for each account, and survive restarts. They are never sent anywhere. There is no limit on the number of events, and logs are kept forever unless you set **deleteAfterDays**. Turn off **persistHistory** to keep new logs only until Discord closes.

Once a week, new days are also copied to `Documents\Equicord Logs\VoiceChannelLog`, one `.jsonl` file per day. These files aren't touched by **Clear logs**. Turn this off with **autoArchive**.

## Limits

- Nothing is recorded while Discord is closed, and calls you are not in are not recorded.
- Logs show what Discord reports, so a muted mic means the user's state says muted, not that their device is silent.
- A server mute shows who was muted, but not which moderator did it.
