# Install pwview on Windows:
#   irm https://raw.githubusercontent.com/<org>/pwview/main/install.ps1 | iex
# Env: PWVIEW_REPO (default below), PWVIEW_VERSION (default latest), PWVIEW_DIR (default %LOCALAPPDATA%\pwview\bin)
$ErrorActionPreference = 'Stop'

$repo    = if ($env:PWVIEW_REPO)    { $env:PWVIEW_REPO }    else { 'victorcesae/pwview' }
$version = if ($env:PWVIEW_VERSION) { $env:PWVIEW_VERSION } else { 'latest' }
$dir     = if ($env:PWVIEW_DIR)     { $env:PWVIEW_DIR }     else { Join-Path $env:LOCALAPPDATA 'pwview\bin' }

$asset = 'pwview-windows-x86_64.exe'
# The repo also publishes Steerhouse releases (steerhouse-v*), so GitHub's "latest" release may not
# be a pwview one. Ask for the newest vX.Y.Z tag instead (the API lists newest first).
if ($version -eq 'latest') {
    $version = (Invoke-RestMethod -Uri "https://api.github.com/repos/$repo/releases?per_page=100" -UseBasicParsing |
        ForEach-Object { $_ } | Where-Object { $_.tag_name -match '^v\d+\.\d+\.\d+$' } | Select-Object -First 1).tag_name
    if (-not $version) { throw "No pwview release found in $repo. Use: cargo install --git https://github.com/$repo" }
}
$url = "https://github.com/$repo/releases/download/$version/$asset"

New-Item -ItemType Directory -Force -Path $dir | Out-Null
$target = Join-Path $dir 'pwview.exe'
Write-Host "Downloading $url"
Invoke-WebRequest -Uri $url -OutFile "$target.tmp" -UseBasicParsing
Move-Item -Force "$target.tmp" $target
Write-Host "Installed $target"

$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (-not ($userPath -split ';' | Where-Object { $_ -eq $dir })) {
    [Environment]::SetEnvironmentVariable('Path', "$userPath;$dir", 'User')
    Write-Host "Added $dir to your user PATH (open a new terminal)."
}
