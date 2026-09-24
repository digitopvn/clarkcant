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
#
# The body is a script block so that `irm | iex` can stop with `return`: `exit` there would close the
# user's PowerShell window.
& {
  $ErrorActionPreference = 'Stop'

  $RepoUrl = if ($env:CLARKCANT_REPO) { $env:CLARKCANT_REPO } else { 'https://github.com/digitopvn/clarkcant.git' }
  $Target = if ($env:CLARKCANT_DIR) { $env:CLARKCANT_DIR } else { 'clarkcant' }
  $Ref = if ($env:CLARKCANT_REF) { $env:CLARKCANT_REF } else { 'main' }

  function Say-Error($Message) { Write-Host "error: $Message" -ForegroundColor Red }

  if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host 'Node.js 22.19+ is required and was not found. Install it with:'
    Write-Host '  winget install OpenJS.NodeJS.LTS      (then open a new terminal)'
    return
  }
  node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=19)?0:1)"
  if ($LASTEXITCODE -ne 0) { Say-Error "Node.js $(node --version) is too old; 22.19+ is required (winget upgrade OpenJS.NodeJS.LTS)."; return }

  if ((Test-Path 'tools/setup.mjs') -and (Test-Path 'pnpm-workspace.yaml')) {
    $Root = (Get-Location).Path
  } else {
    if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Say-Error 'git is required (winget install Git.Git).'; return }
    if (Test-Path (Join-Path $Target '.git')) {
      Write-Host "Using the existing checkout in $Target (not pulling; update it yourself with git pull)."
    } else {
      Write-Host "Cloning $RepoUrl ($Ref) into $Target ..."
      git clone --depth 1 --branch $Ref $RepoUrl $Target
      if ($LASTEXITCODE -ne 0) { Say-Error 'git clone failed.'; return }
    }
    $Root = (Resolve-Path $Target).Path
  }
  Set-Location $Root

  if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
    if (-not (Get-Command corepack -ErrorAction SilentlyContinue)) {
      Say-Error 'Corepack is not bundled with this Node.js (25+). Install it with: npm install -g corepack'
      return
    }
    Write-Host 'Enabling pnpm through Corepack ...'
    corepack enable
    if ($LASTEXITCODE -ne 0) { Say-Error 'corepack enable failed. Run it from an elevated PowerShell, then re-run this script.'; return }
  }

  node tools/setup.mjs @args
} @args
