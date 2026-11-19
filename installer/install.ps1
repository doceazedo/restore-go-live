function Install-RestoreGoLive {
    $ErrorActionPreference = "Stop"
    $ProgressPreference = "SilentlyContinue"

    $repo = if ($env:P2P_REPO) { $env:P2P_REPO } else { "doceazedo/restore-go-live" }
    $baseUrl = if ($env:RGL_RELEASE_URL) { $env:RGL_RELEASE_URL } elseif ($env:P2P_BASE_URL) { $env:P2P_BASE_URL } else { "https://github.com/$repo/releases/latest/download" }
    $branch = $env:P2P_DISCORD_BRANCH
    $assumeYes = $env:P2P_YES -eq "1"

    $branches = [ordered]@{
        stable = @{ Dir = "Discord"; Name = "Discord" }
        ptb    = @{ Dir = "DiscordPTB"; Name = "Discord PTB" }
        canary = @{ Dir = "DiscordCanary"; Name = "Discord Canary" }
    }

    function Say($icon, $color, $text) {
        Write-Host "  $icon " -ForegroundColor $color -NoNewline
        Write-Host $text
    }
    function Step($text) { Say ">" Cyan $text }
    function Ok($text) { Say "+" Green $text }
    function Warn($text) { Say "!" Yellow $text }
    function Fail($text) { Say "x" Red $text }

    function Ask($question, $hint, $default) {
        if ($assumeYes) { return $default }
        Write-Host "  ? " -ForegroundColor Magenta -NoNewline
        Write-Host "$question " -NoNewline
        Write-Host "($hint) " -ForegroundColor DarkGray -NoNewline
        $answer = Read-Host
        if ([string]::IsNullOrWhiteSpace($answer)) { return $default }
        return $answer.Trim().ToLower()
    }
    function Confirm($question) { (Ask $question "Y/n" "y") -match "^y" }

    function Root($label) { Join-Path $env:LOCALAPPDATA $branches[$label].Dir }
    function Names($labels) { ($labels | ForEach-Object { $branches[$_].Name }) -join " and " }

    function Test-Patched($label) {
        $app = Get-ChildItem -Path (Root $label) -Directory -Filter "app-*" -ErrorAction SilentlyContinue |
            Sort-Object { try { [version]$_.Name.Substring(4) } catch { [version]"0.0" } } |
            Select-Object -Last 1
        if (-not $app) { return $false }
        $pkg = Join-Path $app.FullName "resources\app.asar\package.json"
        (Test-Path $pkg -PathType Leaf) -and ((Get-Content $pkg -Raw) -match '"restoreGoLive"\s*:\s*true')
    }

    Write-Host ""
    Write-Host "  RestoreGoLive" -ForegroundColor Magenta
    Write-Host "  P2P screen sharing for Discord" -ForegroundColor DarkGray
    Write-Host ""

    $found = @($branches.Keys | Where-Object { Get-ChildItem -Path (Root $_) -Directory -Filter "app-*" -ErrorAction SilentlyContinue })
    if ($found.Count -eq 0) {
        Fail "No Discord installation found. Install Discord and open it once first."
        return
    }

    $default = if ($found -contains "stable") { "stable" } else { $found[0] }
    if ($branch) {
        $branch = $branch.Trim().ToLower()
    } elseif ($found.Count -gt 1) {
        Ok "Found $(Names $found)"
        $options = (($found + "all") | ForEach-Object { if ($_ -eq $default) { $_.ToUpper() } else { $_ } }) -join "/"
        do {
            $branch = Ask "Which one should RestoreGoLive be installed on?" $options $default
        } until ($branch -eq "all" -or $found -contains $branch)
    } else {
        $branch = $default
    }
    if ($branch -ne "all" -and $found -notcontains $branch) {
        Fail "No $branch installation found."
        return
    }
    $targets = if ($branch -eq "all") { $found } else { @($branch) }

    $patched = @($targets | Where-Object { Test-Patched $_ })
    if ($patched.Count -gt 0) {
        if (-not (Confirm "RestoreGoLive is already installed on $(Names $patched). Reinstall?")) {
            Warn "Installation cancelled."
            return
        }
    } elseif ($found.Count -eq 1 -and -not $env:P2P_DISCORD_BRANCH) {
        if (-not (Confirm "Install RestoreGoLive on $(Names $targets)?")) {
            Warn "Installation cancelled."
            return
        }
    }

    Write-Host ""
    $setup = Join-Path $env:TEMP "restore-go-live-setup"
    New-Item -ItemType Directory -Force -Path $setup | Out-Null
    $cli = Join-Path $setup "restore-go-live.exe"

    Step "Downloading RestoreGoLive..."
    try {
        Invoke-WebRequest -Uri "$baseUrl/restore-go-live.exe" -OutFile $cli -UseBasicParsing
    } catch {
        Fail "Could not download restore-go-live.exe from $baseUrl"
        return
    }

    Step "Installing on $(Names $targets)..."
    $env:RGL_RELEASE_URL = $baseUrl
    $ErrorActionPreference = "Continue"
    $errored = $false
    & $cli install --branch $branch 2>&1 | ForEach-Object {
        $line = "$_".Trim()
        if (-not $line -or $line -match "^done!") { return }
        $line = $line -replace "^FAILED: ", ""
        $text = $line.Substring(0, 1).ToUpper() + $line.Substring(1)
        if ("$_" -match "^(FAILED|Error)" -or $errored) {
            $errored = $true
            Fail $text
        } else {
            Ok $text
        }
    }
    $code = $LASTEXITCODE
    Remove-Item -Recurse -Force $setup -ErrorAction SilentlyContinue

    if ($code -ne 0) {
        Write-Host ""
        Fail "Something went wrong, see the messages above."
        return
    }

    Write-Host ""
    $running = @($targets | Where-Object { Get-Process -Name $branches[$_].Dir -ErrorAction SilentlyContinue })
    if ($running.Count -gt 0) {
        if (Confirm "$(Names $running) is open. Restart it now?") {
            Step "Restarting $(Names $running)..."
            foreach ($label in $running) { Stop-Process -Name $branches[$label].Dir -Force -ErrorAction SilentlyContinue }
            Start-Sleep -Seconds 2
            foreach ($label in $running) {
                $updater = Join-Path (Root $label) "Update.exe"
                if (Test-Path $updater) {
                    Start-Process -FilePath $updater -ArgumentList "--processStart", "$($branches[$label].Dir).exe"
                }
            }
            Ok "Restarted $(Names $running)"
        } else {
            Warn "Fully quit $(Names $running) (including the tray icon) and reopen it to load RestoreGoLive."
        }
    }

    Write-Host ""
    Write-Host "  Done! " -ForegroundColor Green -NoNewline
    Write-Host "RestoreGoLive stays installed across Discord updates and keeps itself up to date."
    Write-Host ""
    Write-Host "  To uninstall, run:" -ForegroundColor DarkGray
    Write-Host "  irm https://doce.sh/restore-go-live/uninstall.ps1 | iex" -ForegroundColor Cyan
    Write-Host ""
}

Install-RestoreGoLive
