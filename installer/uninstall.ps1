function Uninstall-RestoreGoLive {
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
    $targets = if ($branch) { @($branch.Trim().ToLower()) } else { @($branches.Keys) }

    $closed = @()
    foreach ($label in $targets) {
        if (-not $branches.Contains($label)) { continue }
        $exe = $branches[$label]
        if (Get-Process -Name $exe -ErrorAction SilentlyContinue) {
            $answer = if ($assumeYes) { "y" } else { Read-Host "$exe is running and has to be closed, close it now? (y/n) [y]" }
            if ($answer -and $answer -notmatch "^[yY]") {
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
    $installed = Join-Path $env:LOCALAPPDATA "RestoreGoLive\restore-go-live.exe"

    if (Test-Path $installed) {
        Copy-Item -Path $installed -Destination $cli -Force
    } else {
        try {
            Invoke-WebRequest -Uri "$baseUrl/restore-go-live.exe" -OutFile $cli -UseBasicParsing
        } catch {
            Write-Host "error: could not download restore-go-live.exe from $baseUrl"
            return
        }
    }

    $env:RGL_RELEASE_URL = $baseUrl
    $ErrorActionPreference = "Continue"
    if ($branch) { & $cli uninstall --branch $branch } else { & $cli uninstall }
    $code = $LASTEXITCODE
    Remove-Item -Recurse -Force $setup -ErrorAction SilentlyContinue
    if (-not $branch) {
        Remove-Item -Recurse -Force (Join-Path $env:LOCALAPPDATA "RestoreGoLive") -ErrorAction SilentlyContinue
    }
    Remove-Item -Recurse -Force (Join-Path $env:TEMP "restore-go-live") -ErrorAction SilentlyContinue

    foreach ($label in $closed) {
        $updater = Join-Path (Join-Path $env:LOCALAPPDATA $branches[$label]) "Update.exe"
        if (Test-Path $updater) {
            Start-Process -FilePath $updater -ArgumentList "--processStart", "$($branches[$label]).exe"
        }
    }

    if ($code -ne 0) {
        Write-Host ""
        Write-Host "something went wrong, see the messages above"
        return
    }
    Write-Host "done!"
}

Uninstall-RestoreGoLive
