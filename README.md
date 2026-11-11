# equicord-improvements

My custom plugins and settings for [Equicord](https://github.com/Equicord/Equicord), ready to drop into any Equicord source.

The manual plugin bundle was originally built against Equicord 1.15.15.0, commit `00abcbeea`. Full Windows preparation also passed on Equicord 1.15.17.2, commit `32b337cd`. The Windows setup downloads the current official `main` and checks compatibility before applying it.

## Plugins

| Plugin | Origin | What it does |
|---|---|---|
| **ActivityTracker** | Rewritten from [Discord-Activity-Tracker](https://github.com/elioflex/Discord-Activity-Tracker) | Dashboard with voice, messages, reactions, status, profile history and closest contacts for the people you choose |
| **VoiceChannelLog** | [Equicord](https://github.com/Equicord/Equicord), modified | Saved history of the calls you were in, with filters, search and export |
| **VoiceChannelFinder** | Original | Filters the server's voice channel list by person, occupancy and join access, with highlighting and an option to hide other voice channels |
| **ToastNotifications** | [Equicord](https://github.com/Equicord/Equicord), modified | Adds a toast when someone on your list joins a call |
| **FakeDeafen** | [fakedeafen](https://github.com/itskonv1/fakedeafen), modified | Shows you as muted and deafened while you keep hearing |
| **GoLiveBypass** | [GoLiveBypass](https://github.com/bezumiya/GoLiveBypass), modified | Brings back Go Live and camera in Brazil through a WireGuard tunnel for Discord's gateway and media only, with a control panel in the top bar |
| **FakeMedia** | Original | Shows a camera or screen share without sending anything |
| **VoiceFakeDetector** | [Endcord](https://github.com/Endcord/Endcord), adapted | Marks people shown as muted who are still sending audio |
| **ClientModDetector** | Original | Marks people who left visible traces of a modified client |
| **LastMessageDate** | Original | Finds someone's last message in a server, only when you click |
| **LastOnlineTracker** | [LastOnlineTracker](https://github.com/k1ng0p/LastOnlineTracker), modified | Shows when someone went offline, including on their profile |

## Install

### Automatic Windows setup

Download [setup.ps1](https://raw.githubusercontent.com/lsstomas/equicord-improvements/main/setup.ps1) and run it with PowerShell, or use these commands in the folder where you want to download the script:

```powershell
Invoke-WebRequest https://raw.githubusercontent.com/lsstomas/equicord-improvements/main/setup.ps1 -OutFile setup.ps1
powershell -ExecutionPolicy Bypass -File .\setup.ps1
```

Setup installs missing Node.js LTS and Git through Windows Package Manager, downloads the latest Equicord source, installs the pnpm version required by that source, applies this bundle, checks types, runs the six regression suites, and builds the client. Windows may request administrator permission when installing prerequisites.

It detects Discord Stable, Canary and PTB, including Equicord installed with the `.exe` and existing source builds. If several channels are installed, the automatic choice is Stable, then Canary, then PTB. Use `-Channel` to choose another one.

Before applying the build, setup asks to close the selected Discord client. This disconnects an active call. It saves a local backup of the previous loader and Equicord settings, uses the official installer to inject the new build, verifies the loader, enables this bundle's plugins, and opens Discord. The existing Equicord data folder is reused, including themes, plugin data and personal settings. Existing plugin options are preserved. A failed injection restores the previous loader.

Builds and backups stay in `%LOCALAPPDATA%\EquicordImprovements`. Keep the active build folder there, because Discord loads it directly. Equicord's automatic updater is disabled for this customized build; rerun setup to download and validate a newer version. If an upstream change breaks a check or build, setup stops before applying it to Discord. The Proton account and route are configured inside GoLiveBypass.

```powershell
.\setup.ps1 -DetectOnly
.\setup.ps1 -Channel canary
.\setup.ps1 -DiscordPath 'D:\Apps\Discord'
.\setup.ps1 -PrepareOnly -InstallDirectory 'D:\EquicordImprovements'
```

`-DetectOnly` reports the existing installation. `-PrepareOnly` downloads, builds and validates the new version without changing Discord or its settings. `-NoLaunch` leaves Discord closed after installation. `-Yes` skips the final closure prompt for unattended installation.

### Manual installation

You need an [Equicord source install](https://github.com/Equicord/Equicord), Node.js, pnpm and Git.

```sh
git clone https://github.com/lsstomas/equicord-improvements
node equicord-improvements/install.mjs path/to/Equicord
```

Then, inside the Equicord folder:

```sh
pnpm build
pnpm inject
```

Restart Discord completely, and turn the plugins on in Equicord's settings. To also apply my plugin options, close Discord and add `--settings` to the install command.

To install with an AI agent, give it this:

> Follow AGENTS.md in https://github.com/lsstomas/equicord-improvements to install these plugins.

## GoLiveBypass

GoLiveBypass runs on Windows x64 and Linux x64, and needs a ProtonVPN account or your own WireGuard `.conf` file. Open it from the shield icon in Discord's top bar.

- Press **Go Live** once and it stays on every time Discord opens. The first time, Discord reloads once if your session is blocked, and Windows asks for permission to install WireSock.
- **Turn off** stops the tunnel without restarting Discord. A stream you open after turning it back on goes through the tunnel again.
- Only Discord's gateway and media use the tunnel. Its API, your browser and other apps stay on your normal network.
- While it's on, calls go through the route, so voice has more latency.
- If a route stops responding, or Discord's connection stays down for 15 seconds, it restarts that route and then tries others. If none responds, Discord stays on your normal network and the panel says so.
- Closing Discord doesn't wait for the tunnel: it's asked to stop and the window closes right away.
- The camera and screen buttons stay unlocked with Go Live on or off, as long as the plugin is on.
- Optimize tests routes through the tunnel, so avoid it during a call.
- On Windows with WSL's mirrored networking, installing the WireSock driver can cut WSL's network until you restart.

Auto-update stays off, because an update would replace the control panel.

Local revision `2.0.13-improvements.1` reads Windows service state without relying on English field labels and uses CIM for the service configuration. It waits for a graceful service stop before trying to terminate remaining owned processes. New routes get up to eight startup probes, and probe failures include HTTP status, country or a network error in the local log. The dedicated probe session closes old connections after a tunnel starts.

To reopen setup after **Set up later**, use **Run setup** in the plugin settings, the toolbox or the panel's **Advanced** tab.

## Recent compatibility fixes

- VoiceChannelFinder works alongside Dragify. Participant searches highlight the exact channel, and **Empty** with **Hide non-matching voice channels** hides occupied voice channels.
- AudioPlayerAPI preserves Discord's native sound arguments. This fixes mute, deafen and call join/leave sounds failing with a non-finite volume error.

## Layout

```
src/        Mirrors Equicord's src folder, so it can be copied straight over
patches/    The change to LastOnlineTracker
settings/   My plugin options, without personal data
tests/      Tests, which run from Equicord's scripts folder
tools/      Maintainer tools for syncing and privacy checks
install.mjs Installs everything into an Equicord source
setup.ps1   Windows setup, including missing prerequisites
setup.mjs   Installation detection, build checks, backup and injection
AGENTS.md   Install guide for AI agents
```

`ActivityTracker` depends on files in `voiceChannelLog`, and `FakeMedia` depends on `FakeDeafen`, so install them together. `install.mjs` does this for you.

`src/equicordplugins` replaces ToastNotifications, VoiceChannelLog and AudioPlayerAPI. If Equicord has changed these files since the commit above, those changes are overwritten.

`LastOnlineTracker` has no license file, so only my change is stored here. The installer downloads the author's original and applies the patch.

GoLiveBypass's Proton helper is a 14 MB prebuilt file, so it isn't stored here either. On Windows, the installer downloads it from the author's release and checks its SHA-256.

## Privacy

Everything these plugins record stays on your device. `settings/settings.public.json` goes through an allowlist that only keeps on and off values and small numbers, so IDs, names and links stay out. Logs, saved images and full backups are never committed.

## Updating this repository

```sh
node tools/sync.mjs
git config core.hooksPath .githooks
```

`sync.mjs` copies plugins from `../source` and stops if it finds anything personal. The hook repeats that check before every push.

Run `node tools/setup.test.mjs` for setup detection, settings and recovery tests. End-to-end preparation can be checked with `setup.ps1 -PrepareOnly`.

## Disclaimer

Client mods break Discord's Terms of Service and can get your account punished. Use these at your own risk, and respect the people you share Discord with.

## License

[GPL-3.0](LICENSE), the same as Equicord and Vencord. Credits are in the table above and in each plugin's `UPSTREAM.md`.
