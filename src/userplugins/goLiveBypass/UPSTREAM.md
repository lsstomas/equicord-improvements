Based on https://github.com/bezumiya/GoLiveBypass at v2.0.13 (GPL-3.0).

`bin/win32-x64/proton-confgen.exe` isn't stored here. `install.mjs` downloads it from that release and checks its SHA-256.

Local changes:
- Local revision `2.0.13-improvements.1` adds service detection independent of Windows display language, a grace period for service shutdown, longer startup probing, probe diagnostics and shortcuts to reopen setup.
- Adds a control panel with a status icon in Discord's top bar.
- Shows the bypass state, a single main button and a status check.
- Moves routes, account and advanced options into tabs, and leaves a shortcut in the plugin settings.
- Translates the interface to English. Errors from the desktop process stay in Portuguese.
- Warns that Optimize turns the bypass off during the test.
- Replaces the always-on tunnel on Windows with a Go Live switch (`go-live.ts`). While it's on, only Discord's gateway and media use the tunnel, through an IP filter. It holds the gateway until the tunnel is up, replaces a dead route by itself, and falls back to the normal network if none responds.
- Lets your account start and stop the WireSock service after the first activation, so Go Live doesn't ask for permission each time.
- Leaves `Update.exe` outside the tunnel.
- Updates to the current Equicord `Button` and `showToast` APIs.
- Turns auto-update off by default, because an update would replace these changes.
