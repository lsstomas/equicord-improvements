Based on https://github.com/elioflex/Discord-Activity-Tracker at 29da3a3cf6612f0307ad32a639e0624ea77c45f0 (GPL-3.0).
Audited on 2026-11-01: no network access, tokens, native code or injected HTML.

Rewritten locally. The tracking idea and the name come from upstream, while the storage, the event handling and the whole dashboard are new:
- Saves logs by day with no event limit, keeps 90 days in memory and copies logs to Documents\\Equicord Logs weekly.
- Records messages, edits, deletions, reactions and typing from everything the client receives.
- Records mute, deafen, camera and screenshare changes, who shares a call and back-and-forth conversations.
- Keeps a history of profile versions and saves avatars and banners to Documents\\Equicord Logs.
- Adds a top bar button.

It only reads what Discord already sends this client. It never subscribes to extra channels or searches servers, because that would be automation on the account.
