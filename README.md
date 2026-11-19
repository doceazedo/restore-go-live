# RestoreGoLive

Replaces Discord's Go Live with P2P screen sharing. It patches the Discord desktop app directly, no Vencord needed.

## Installing

On Windows, open PowerShell and run:

```
irm https://doce.sh/restore-go-live/install.ps1 | iex
```

This installs a small background helper that re-patches Discord after every Discord update and keeps RestoreGoLive up to date from GitHub releases. If Discord is open, the installer offers to close it and opens it again when it's done.

On macOS / Linux, open your terminal and run:

```sh
curl -fsSL https://doce.sh/restore-go-live/install.sh | bash
```

There's no background helper on macOS and Linux yet, so rerun the installer after Discord updates.

If you have more than one Discord installed (Stable, PTB, Canary), the installer asks which one to patch. You can answer `all`.

### Browser extension

> [!WARNING]  
> Broadcasting only works on the desktop app. You can still use the browser extension for watching streams tho.

On Chrome, download [extension-chrome.zip](https://github.com/doceazedo/restore-go-live/releases/download/latest/extension-chrome.zip) and unzip it. Go to `chrome://extensions`, turn on developer mode and click "Load unpacked".

On Firefox, download [extension-firefox.zip](https://github.com/doceazedo/restore-go-live/releases/download/latest/extension-firefox.zip). Go to `about:debugging#/runtime/this-firefox`, click "Load Temporary Add-on" and pick the zip.

## Uninstalling

Windows:

```
irm https://doce.sh/restore-go-live/uninstall.ps1 | iex
```

macOS / Linux:

```sh
curl -fsSL https://doce.sh/restore-go-live/uninstall.sh | bash
```

Both also clean up the old Vencord-based version of RestoreGoLive. A regular Vencord install is left alone.

## Command line (Windows)

The installer puts `restore-go-live.exe` in `%LOCALAPPDATA%\RestoreGoLive`. From that folder:

| Command | What it does |
| --- | --- |
| `restore-go-live status` | Shows each Discord install, whether it's patched, and the helper's state |
| `restore-go-live install [--branch stable\|ptb\|canary\|all]` | Patches Discord and sets up the background helper |
| `restore-go-live update [--check]` | Updates RestoreGoLive right away instead of waiting for the helper |
| `restore-go-live uninstall [--branch ...]` | Restores Discord and removes RestoreGoLive |

`install` refuses to replace another mod's patch (like Vencord) unless you pass `--force`.

## Settings

Settings live in `%APPDATA%\RestoreGoLive\settings.json` (on macOS `~/Library/Application Support/RestoreGoLive/settings.json`, on Linux `~/.config/RestoreGoLive/settings.json`) and apply while Discord is running:

```json
{
  "uploadBudgetMbps": 15,
  "desktopAudio": "auto",
  "stunServers": "stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302,stun:stun.cloudflare.com:3478"
}
```

- `uploadBudgetMbps`: total upload shared between your viewers
- `desktopAudio`: `auto` shares the audio of the window you picked, `off` shares none, or the name of an input device (BlackHole, Monitor, Stereo Mix) to capture that instead
- `stunServers`: comma separated STUN servers

The background helper reads `%APPDATA%\RestoreGoLive\state.json`. Set `"autoUpdate": false` to stop automatic updates, or `"relaunchAfterUpdate": false` to stop it from restarting Discord when Discord starts unpatched right after updating itself.

## Troubleshooting

Logs are in `%APPDATA%\RestoreGoLive\logs`:

- `daemon.log`: the background helper (patching, updates)
- `main.log`: Discord loading RestoreGoLive

If Discord starts without RestoreGoLive, run `restore-go-live status`, or just run the installer again.

## Development

```sh
pnpm install
pnpm build                  # dist/: main.js, preload.js, renderer.js and the browser extensions
pnpm typecheck
cargo test --manifest-path patcher/Cargo.toml
pnpm run deploy --branch canary # builds and patches your local Discord Canary with dist/
```

- `src/`: the plugin (P2P signaling, capture, the Discord patches)
- `runtime/`: the small runtime that loads the plugin into Discord (Electron main process, preload, webpack patching)
- `patcher/`: the Rust patcher, background helper and updater
- `installer/`: the install / uninstall scripts

Every push to `main` builds everything on CI and publishes the `latest` release with a `manifest.json` the updater uses.
