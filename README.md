# RestoreGoLive

Replaces Discord's Go Live with P2P screen sharing by patching the desktop app.

## Installing

On Windows, open PowerShell and run:

```
irm https://doce.sh/restore-go-live/install.ps1 | iex
```

This installs a background helper that patches Discord after every update & auto-updates itself.

On macOS / Linux, open your terminal and run:

```sh
curl -fsSL https://doce.sh/restore-go-live/install.sh | bash
```

> [!WARNING]  
> There's no background helper on macOS and Linux yet.

## Uninstalling

Windows:

```
irm https://doce.sh/restore-go-live/uninstall.ps1 | iex
```

macOS / Linux:

```sh
curl -fsSL https://doce.sh/restore-go-live/uninstall.sh | bash
```

## CLI

CLI is installed at:

- Windows: `%LOCALAPPDATA%\RestoreGoLive`
- Mac/Linux: N/A

```
Usage: restore-go-live.exe [COMMAND]

Commands:
  status     Show detected Discord installs and their patch state
  install    Install the payload and patch Discord
  uninstall  Restore the original Discord and remove RestoreGoLive
  update     Update the payload and programs from the latest release
  daemon     Run the background daemon in the foreground
  help       Print this message or the help of the given subcommand(s)

Options:
  -h, --help     Print help
  -V, --version  Print version
```

## Settings

Settings file is saved at:

- Windows: `%LOCALAPPDATA%\RestoreGoLive`
- Mac: `~/Library/Application Support/RestoreGoLive/settings.json`
- Linux: `~/.config/RestoreGoLive/settings.json`

## Development

Build the program and patch your local Discord install:

```sh
pnpm deploy --branch stable
```
