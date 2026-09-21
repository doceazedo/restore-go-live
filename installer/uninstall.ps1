$ErrorActionPreference = "Continue"

$data = Join-Path $env:APPDATA "Vencord"
$branches = @("Discord", "DiscordPTB", "DiscordCanary", "DiscordDevelopment")

foreach ($branch in $branches) {
    $root = Join-Path $env:LOCALAPPDATA $branch
    if (-not (Test-Path $root)) { continue }
    Get-ChildItem -Path $root -Directory -Filter "app-*" -ErrorAction SilentlyContinue | ForEach-Object {
        $res = Join-Path $_.FullName "resources"
        $orig = Join-Path $res "_app.asar"

        foreach ($shim in @((Join-Path $res "app.asar"), (Join-Path $res "app"))) {
            if ((Test-Path $shim -PathType Container) -and (Test-Path (Join-Path $shim "index.js"))) {
                Remove-Item -Recurse -Force $shim
                Write-Host "removed shim from $res"
            }
        }
        if ((Test-Path $orig -PathType Leaf) -and -not (Test-Path (Join-Path $res "app.asar"))) {
            Move-Item -Path $orig -Destination (Join-Path $res "app.asar") -Force
            Write-Host "restored original app.asar in $res"
        }
    }
}

Remove-Item -Recurse -Force (Join-Path $data "dist") -ErrorAction SilentlyContinue
Write-Host "done! restart Discord"
