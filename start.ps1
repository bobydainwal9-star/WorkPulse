$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Write-Host 'Install Node.js 20 LTS or newer from https://nodejs.org/'; Read-Host 'Press Enter to exit'; exit 1 }
if (-not (Test-Path 'node_modules')) { npm install }
if (-not (Test-Path '.env')) { Copy-Item '.env.example' '.env' }
npm start
