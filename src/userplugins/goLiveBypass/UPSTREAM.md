Based on https://github.com/bezumiya/GoLiveBypass at v2.0.13 (GPL-3.0).

`bin/win32-x64/proton-confgen.exe` isn't stored here. `install.mjs` downloads it from that release and checks its SHA-256.

Local changes:
- Adds a control panel with a status icon in Discord's top bar.
- Shows the bypass state, a single on/off button and a status check.
- Moves routes, account and advanced options into tabs, and leaves a shortcut in the plugin settings.
- Translates the interface to English. Errors from the desktop process stay in Portuguese.
- Warns that Optimize turns the bypass off during the test.
- Keeps the tunnel on when Discord closes and after a restart on Windows, until you turn it off in the panel.
- Offers to turn the tunnel off from a native dialog if it stops responding when Discord opens.
- Asks you to reconnect if a Discord update leaves the app outside the tunnel.
- Updates to the current Equicord `Button` and `showToast` APIs.
- Turns auto-update off by default, because an update would replace these changes.
