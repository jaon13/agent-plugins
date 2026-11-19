<#
.SYNOPSIS
One-step Windows installer for Antigravity agent-plugins.
Usage:
  irm https://raw.githubusercontent.com/jaon13/agent-plugins/main/install.ps1 | iex
#>
param(
    [string]$StageDir = $(if ($env:AGENT_PLUGINS_HOME) { $env:AGENT_PLUGINS_HOME } else { Join-Path $HOME ".agents\agent-plugins" }),
    [string]$Repo = "jaon13/agent-plugins",
    [switch]$WithCodeXray,
    [switch]$InitConfig
)

$ErrorActionPreference = "Stop"

$pyCmd = Get-Command python -ErrorAction SilentlyContinue
if (-not $pyCmd) { $pyCmd = Get-Command python3 -ErrorAction SilentlyContinue }
if (-not $pyCmd) {
    throw "Python 3.10+ is required to install agent-plugins."
}

New-Item -ItemType Directory -Path (Split-Path $StageDir -Parent) -Force | Out-Null

$gitCmd = Get-Command git -ErrorAction SilentlyContinue
if ($gitCmd) {
    if (Test-Path (Join-Path $StageDir ".git")) {
        Write-Host "[agent-plugins] Updating $StageDir ..."
        git -C $StageDir pull --ff-only
    } else {
        if (Test-Path $StageDir) {
            Remove-Item $StageDir -Recurse -Force
        }
        Write-Host "[agent-plugins] Cloning https://github.com/$Repo.git -> $StageDir ..."
        git clone --depth 1 "https://github.com/$Repo.git" $StageDir
    }
} else {
    $tmpZip = Join-Path ([System.IO.Path]::GetTempPath()) "agent-plugins-$PID.zip"
    $tmpExtract = Join-Path ([System.IO.Path]::GetTempPath()) "agent-plugins-$PID"
    Invoke-WebRequest -Uri "https://github.com/$Repo/archive/refs/heads/main.zip" -OutFile $tmpZip
    Expand-Archive -Path $tmpZip -DestinationPath $tmpExtract -Force
    $inner = Get-ChildItem $tmpExtract -Directory | Select-Object -First 1
    New-Item -ItemType Directory -Path $StageDir -Force | Out-Null
    Copy-Item (Join-Path $inner.FullName "*") $StageDir -Recurse -Force
    Remove-Item $tmpZip, $tmpExtract -Recurse -Force -ErrorAction SilentlyContinue
}

$argsList = @((Join-Path $StageDir "scripts\install_plugins.py"), "--enable")
if ($InitConfig -or $env:AGENT_PLUGINS_INIT_CONFIG -eq "1") {
    $argsList += "--init-config"
}
& $pyCmd.Source @argsList
if ($LASTEXITCODE -ne 0) { throw "install_plugins.py failed ($LASTEXITCODE)" }

if ($WithCodeXray -or $env:WITH_CODE_XRAY -eq "1") {
    Write-Host "[agent-plugins] Installing companion CodeXray ..."
    irm https://raw.githubusercontent.com/jaon13/code-xray/main/install.ps1 | iex
}
