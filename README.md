# RestoreGoLive

[Vencord](https://vencord.dev) plugin to replace Discord's Go Live with P2P screen sharing.

## Installing

This script will automatically install Vencord + the RestoreGoLive plugin for you.

On Windows, open PowerShell and run:

```
irm https://doce.sh/restore-go-live/install.ps1 | iex
```

On macOS / Linux, open your terminal and run:

```sh
curl -fsSL https://doce.sh/restore-go-live/install.sh | bash
```

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
