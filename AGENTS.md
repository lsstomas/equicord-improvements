# Installing equicord-improvements

Instructions for an AI agent installing these plugins for a user.

## Before you start

- Requires Node.js 18 or newer, pnpm and Git. Equicord's `package.json` sets the pnpm version, and `corepack pnpm` picks it up.
- Find out whether the user already has an Equicord source folder. If not, clone https://github.com/Equicord/Equicord and run `pnpm install --frozen-lockfile`.
- Ask before running `--settings`, `pnpm inject`, or restarting Discord. These change the user's setup, and a restart can drop them from a call.

## Steps

1. Clone this repository next to the Equicord folder.
2. Run `node install.mjs <path to Equicord>` from this repository.
3. From the Equicord folder, run `pnpm build`.
4. If Equicord isn't injected yet, run `pnpm inject`.
5. To apply the saved options, close Discord completely and run `node install.mjs <path to Equicord> --settings`.
6. Have the user quit Discord from the system tray and open it again. A reload isn't enough, because ActivityTracker and VoiceChannelLog include native code.
7. If `--settings` wasn't used, have the user turn on the plugins in Equicord's settings. ActivityTracker and LastOnlineTracker don't turn on by themselves.

## Verify

- `node_modules/.bin/tsc --noEmit` passes in the Equicord folder.
- All four tests pass: `node scripts/testVoiceChannelHistory.mjs`, `testUserplugins.mjs`, `testActivityTracker.mjs` and `testToastVoiceTracking.mjs`.
- The radar icon appears in Discord's top bar and opens the dashboard.

## If something fails

- **TypeScript or build errors in `voiceChannelLog` or `toastNotifications`:** Equicord changed these plugins. Compare with commit `00abcbeea`, which this repository was built against, and report the conflict. Don't delete the user's plugins to get past it.
- **`git apply` fails on LastOnlineTracker:** the author's file changed. It's pinned to a commit, so check that the download worked.
- **Settings aren't saving:** restart Discord completely, then check the time on `settings.json`.

## Rules

- Never commit `settings.json`, exports, logs or the `Equicord Logs` folder. They contain other people's IDs and activity.
- Leave `autoRefreshProfiles` off unless the user asks. It sends automated requests to Discord.
- Don't bypass age verification or other Discord safety checks.
