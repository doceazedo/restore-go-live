$ErrorActionPreference = "Stop"

$repo = if ($env:P2P_REPO) { $env:P2P_REPO } else { "doceazedo/restore-go-live" }
$baseUrl = if ($env:P2P_BASE_URL) { $env:P2P_BASE_URL } else { "https://github.com/$repo/releases/latest/download" }
$branch = $env:P2P_DISCORD_BRANCH
$files = @("patcher.js", "preload.js", "renderer.js", "renderer.css")

$data = Join-Path $env:APPDATA "Vencord"
$distDir = Join-Path $data "dist"

$branchDirs = [ordered]@{
    stable = "Discord"
    ptb    = "DiscordPTB"
    canary = "DiscordCanary"
}

$found = [ordered]@{}
foreach ($label in $branchDirs.Keys) {
    $root = Join-Path $env:LOCALAPPDATA $branchDirs[$label]
    if (-not (Test-Path $root)) { continue }
    $res = Get-ChildItem -Path $root -Directory -Filter "app-*" -ErrorAction SilentlyContinue |
        Sort-Object Name -Descending |
        ForEach-Object { Join-Path $_.FullName "resources" } |
        Where-Object { (Test-Path (Join-Path $_ "app.asar")) -or (Test-Path (Join-Path $_ "_app.asar")) } |
        Select-Object -First 1
    if ($res) { $found[$label] = $res }
}

if ($found.Count -eq 0) {
    Write-Host "error: no Discord installation found, install Discord and launch it once first"
    exit 1
}

$default = if ($found.Contains("stable")) { "stable" } else { @($found.Keys)[0] }

if ($found.Count -gt 1 -and -not $branch) {
    $opts = (@($found.Keys) + "all") -join "/"
    $branch = Read-Host "which Discord installation do you want to patch? ($opts) [$default]"
}

$branch = if ($branch) { $branch.Trim().ToLower() } else { $default }

$targets = [ordered]@{}
if ($branch -eq "all") {
    $targets = $found
} elseif ($found.Contains($branch)) {
    $targets[$branch] = $found[$branch]
} else {
    $first = @($found.Keys)[0]
    Write-Host "no '$branch' install found, using $first instead"
    $targets[$first] = $found[$first]
}

Write-Host ""
Write-Host "downloading RestoreGoLive..."
New-Item -ItemType Directory -Force -Path $distDir | Out-Null
foreach ($f in $files) {
    try {
        Invoke-WebRequest -Uri "$baseUrl/$f" -OutFile (Join-Path $distDir $f) -UseBasicParsing
    } catch {
        Write-Host "error: could not download $f"
        exit 1
    }
}
Set-Content -Path (Join-Path $distDir "package.json") -Value "{}" -NoNewline
Write-Host "plugin files installed to $distDir"

$patcher = (Join-Path $distDir "patcher.js") -replace '\\', '\\'

foreach ($label in $targets.Keys) {
    $res = $targets[$label]
    $asar = Join-Path $res "app.asar"
    $orig = Join-Path $res "_app.asar"
    Write-Host ""
    Write-Host "-> $label"

    $fresh = $false
    if (Test-Path $asar -PathType Leaf) {
        try {
            Remove-Item -Force $orig -ErrorAction SilentlyContinue
            Move-Item -Path $asar -Destination $orig -Force
        } catch {
            Write-Host "   FAILED: cannot write to $res, fully close Discord and try again"
            continue
        }
        $fresh = $true
    }

    if (-not (Test-Path $orig -PathType Leaf)) {
        Write-Host "   skipped: no app.asar"
        continue
    }

    $legacy = Join-Path $res "app"
    if (Test-Path (Join-Path $legacy "index.js")) {
        Remove-Item -Recurse -Force $legacy
    }

    New-Item -ItemType Directory -Force -Path $asar | Out-Null
    Set-Content -Path (Join-Path $asar "index.js") -Value "require(`"$patcher`");"
    Set-Content -Path (Join-Path $asar "package.json") -Value '{"name":"discord","main":"index.js"}'

    if ($fresh) {
        Write-Host "   patched"
    } else {
        Write-Host "   already patched, plugin files refreshed"
    }
}

Write-Host ""
Write-Host "done! fully quit and reopen Discord :)"
