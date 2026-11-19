function Install-RestoreGoLive {
    $ErrorActionPreference = "Stop"
    $ProgressPreference = "SilentlyContinue"

    $repo = if ($env:P2P_REPO) { $env:P2P_REPO } else { "doceazedo/restore-go-live" }
    $baseUrl = if ($env:RGL_RELEASE_URL) { $env:RGL_RELEASE_URL } elseif ($env:P2P_BASE_URL) { $env:P2P_BASE_URL } else { "https://github.com/$repo/releases/latest/download" }
    $branch = $env:P2P_DISCORD_BRANCH
    $assumeYes = $env:P2P_YES -eq "1"

    $branches = [ordered]@{
        stable = "Discord"
        ptb    = "DiscordPTB"
        canary = "DiscordCanary"
    }

    function Ask($question, $default) {
        if ($assumeYes) { return $default }
        $answer = Read-Host "$question [$default]"
        if ([string]::IsNullOrWhiteSpace($answer)) { return $default }
        return $answer.Trim().ToLower()
    }

    $found = @()
    foreach ($label in $branches.Keys) {
        $root = Join-Path $env:LOCALAPPDATA $branches[$label]
        if (Get-ChildItem -Path $root -Directory -Filter "app-*" -ErrorAction SilentlyContinue) { $found += $label }
    }

    if ($found.Count -eq 0) {
        Write-Host "error: no Discord installation found, install Discord and launch it once first"
        return
    }

    $default = if ($found -contains "stable") { "stable" } else { $found[0] }
    if (-not $branch) {
        $branch = if ($found.Count -gt 1) { Ask "which Discord installation do you want to patch? ($(($found + 'all') -join '/'))" $default } else { $default }
    }
    $branch = $branch.Trim().ToLower()
    if ($branch -ne "all" -and $found -notcontains $branch) {
        Write-Host "no '$branch' install found, using $default instead"
        $branch = $default
    }
    $targets = if ($branch -eq "all") { $found } else { @($branch) }

    $closed = @()
    foreach ($label in $targets) {
        $exe = $branches[$label]
        if (Get-Process -Name $exe -ErrorAction SilentlyContinue) {
            $answer = Ask "$exe is running and has to be closed to patch it, close it now? (y/n)" "y"
            if ($answer -notmatch "^y") {
                Write-Host "fully quit $exe (including the tray icon) and run this again"
                return
            }
            Stop-Process -Name $exe -Force
            $closed += $label
        }
    }
    if ($closed.Count -gt 0) { Start-Sleep -Seconds 2 }

    $setup = Join-Path $env:TEMP "restore-go-live-setup"
    New-Item -ItemType Directory -Force -Path $setup | Out-Null
    $cli = Join-Path $setup "restore-go-live.exe"

    Write-Host "downloading RestoreGoLive..."
    try {
        Invoke-WebRequest -Uri "$baseUrl/restore-go-live.exe" -OutFile $cli -UseBasicParsing
    } catch {
        Write-Host "error: could not download restore-go-live.exe from $baseUrl"
        return
    }

    $env:RGL_RELEASE_URL = $baseUrl
    $ErrorActionPreference = "Continue"
    & $cli install --branch $branch
    $code = $LASTEXITCODE
    Remove-Item -Recurse -Force $setup -ErrorAction SilentlyContinue

    foreach ($label in $closed) {
        $root = Join-Path $env:LOCALAPPDATA $branches[$label]
        $updater = Join-Path $root "Update.exe"
        if (Test-Path $updater) {
            Start-Process -FilePath $updater -ArgumentList "--processStart", "$($branches[$label]).exe"
        }
    }

    if ($code -ne 0) {
        Write-Host ""
        Write-Host "something went wrong, see the messages above"
        return
    }
    Write-Host ""
    Write-Host "RestoreGoLive stays installed across Discord updates and keeps itself up to date."
}

Install-RestoreGoLive
