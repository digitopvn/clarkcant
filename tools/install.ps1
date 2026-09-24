# ClarkCant installer for Windows (PowerShell 5.1+ or PowerShell 7).
#
#   irm https://raw.githubusercontent.com/digitopvn/clarkcant/main/tools/install.ps1 | iex
#   powershell -ExecutionPolicy Bypass -File tools\install.ps1 [setup options]   # from a checkout
#
# It checks for git and Node.js 22.19+, clones the repository when run outside one, enables pnpm through
# Corepack and hands over to the interactive onboarding (tools/setup.mjs). It never installs Node or Docker
# itself; it prints the winget command instead, because that choice belongs to whoever owns the machine.
#
# $env:CLARKCANT_DIR  where to clone (default: .\clarkcant)
# $env:CLARKCANT_REF  branch or tag (default: main)
$ErrorActionPreference = 'Stop'

$RepoUrl = if ($env:CLARKCANT_REPO) { $env:CLARKCANT_REPO } else { 'https://github.com/digitopvn/clarkcant.git' }
$Target = if ($env:CLARKCANT_DIR) { $env:CLARKCANT_DIR } else { 'clarkcant' }
$Ref = if ($env:CLARKCANT_REF) { $env:CLARKCANT_REF } else { 'main' }

function Fail($Message) { Write-Host "error: $Message" -ForegroundColor Red; exit 1 }

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host 'Node.js 22.19+ is required and was not found. Install it with:'
  Write-Host '  winget install OpenJS.NodeJS.LTS      (then open a new terminal)'
  exit 1
}
node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=19)?0:1)"
if ($LASTEXITCODE -ne 0) { Fail "Node.js $(node --version) is too old; 22.19+ is required (winget upgrade OpenJS.NodeJS.LTS)." }

if ((Test-Path 'tools/setup.mjs') -and (Test-Path 'pnpm-workspace.yaml')) {
  $Root = (Get-Location).Path
} else {
  if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Fail 'git is required (winget install Git.Git).' }
  if (Test-Path (Join-Path $Target '.git')) {
    Write-Host "Using the existing checkout in $Target (not pulling; update it yourself with git pull)."
  } else {
    Write-Host "Cloning $RepoUrl ($Ref) into $Target ..."
    git clone --depth 1 --branch $Ref $RepoUrl $Target
    if ($LASTEXITCODE -ne 0) { Fail 'git clone failed.' }
  }
  $Root = (Resolve-Path $Target).Path
}
Set-Location $Root

if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
  Write-Host 'Enabling pnpm through Corepack ...'
  corepack enable
  if ($LASTEXITCODE -ne 0) { Fail 'corepack enable failed. Run it from an elevated PowerShell, then re-run this script.' }
}

node tools/setup.mjs @args
exit $LASTEXITCODE
