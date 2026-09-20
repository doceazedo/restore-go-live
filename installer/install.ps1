$ErrorActionPreference = "Stop"

$repo = if ($env:P2P_REPO) { $env:P2P_REPO } else { "doceazedo/restore-go-live" }
$baseUrl = if ($env:P2P_BASE_URL) { $env:P2P_BASE_URL } else { "https://github.com/$repo/releases/latest/download" }
$files = @("patcher.js", "preload.js", "renderer.js", "renderer.css")

function Say($msg) { Write-Host $msg }

$data = Join-Path $env:APPDATA "Vencord"
$distDir = Join-Path $data "dist"

$branches = @("Discord", "DiscordPTB", "DiscordCanary", "DiscordDevelopment")
$targets = @()
foreach ($branch in $branches) {
    $root = Join-Path $env:LOCALAPPDATA $branch
    if (-not (Test-Path $root)) { continue }
    Get-ChildItem -Path $root -Directory -Filter "app-*" -ErrorAction SilentlyContinue |
        Sort-Object Name -Descending | ForEach-Object {
            $res = Join-Path $_.FullName "resources"
            if (Test-Path (Join-Path $res "app.asar")) { $targets += $res }
            elseif (Test-Path (Join-Path $res "_app.asar")) { $targets += $res }
        }
}

if ($targets.Count -eq 0) {
    Say "error: no Discord installation found, install Discord and launch it once first"
    exit 1
}

Say "downloading RestoreGoLive..."
New-Item -ItemType Directory -Force -Path $distDir | Out-Null
foreach ($f in $files) {
    try {
        Invoke-WebRequest -Uri "$baseUrl/$f" -OutFile (Join-Path $distDir $f) -UseBasicParsing
    } catch {
        Say "error: could not download $f"
        exit 1
    }
}
Set-Content -Path (Join-Path $distDir "package.json") -Value "{}" -NoNewline
Say "plugin files installed to $distDir"

$patcher = (Join-Path $distDir "patcher.js") -replace '\\', '\\'

foreach ($res in $targets) {
    $label = Split-Path (Split-Path $res -Parent) -Leaf
    Say ""
    Say "-> $label"

    if (Test-Path (Join-Path $res "_app.asar")) {
        Say "   already patched by an earlier install, plugin files refreshed"
        continue
    }

    try {
        Move-Item -Path (Join-Path $res "app.asar") -Destination (Join-Path $res "_app.asar") -Force
    } catch {
        Say "   FAILED: cannot write to $res, close Discord and try again"
        continue
    }

    $appDir = Join-Path $res "app"
    New-Item -ItemType Directory -Force -Path $appDir | Out-Null
    Set-Content -Path (Join-Path $appDir "index.js") -Value "require(`"$patcher`");"
    Set-Content -Path (Join-Path $appDir "package.json") -Value '{"name":"discord","main":"index.js"}'
    Say "   patched"
}

Say ""
Say "done! fully quit and reopen Discord :)"
