# Syntra quickstart for Windows PowerShell 5.1 and PowerShell 7. The same
# steps as scripts/quickstart.sh: writes .env with generated secrets beside
# docker-compose.yml, starts the stack and waits for it to be ready.
#
#   .\scripts\quickstart.ps1 -Email you@example.com
#   .\scripts\quickstart.ps1 -Domain idm.example.com -Email you@example.com -SmtpUrl smtp://mail.example.com:25
#
# See docs/install.md, "Quickstart".
[CmdletBinding()]
param(
  [string]$Domain,
  [string]$Email,
  [string]$SmtpUrl,
  [string]$Version,
  [string]$Org = 'Syntra',
  [string]$Project,
  [switch]$Bootstrap,
  [switch]$OwnProxy,
  [switch]$NoStart
)
$ErrorActionPreference = 'Stop'

function Fail([string]$Message) { Write-Host "quickstart: $Message" -ForegroundColor Red; exit 1 }

function New-Secret([int]$Bytes, [switch]$Hex) {
  $buffer = New-Object byte[] $Bytes
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($buffer)
  if ($Hex) { return (($buffer | ForEach-Object { $_.ToString('x2') }) -join '') }
  return [Convert]::ToBase64String($buffer)
}

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
if (-not (Test-Path docker-compose.yml)) { Fail "docker-compose.yml not found in $root." }
$envPath = Join-Path $root '.env'
if (Test-Path $envPath) { Fail ".env already exists in $root. Not overwritten. Start the existing install with: docker compose up -d" }
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { Fail 'docker not found. Install Docker Desktop first.' }

if (-not $Domain) { $Domain = Read-Host 'Domain (localhost to try it on this machine) [localhost]' }
if (-not $Domain) { $Domain = 'localhost' }
if (-not $Email) { $Email = Read-Host "First administrator's email" }
if (-not $PSBoundParameters.ContainsKey('SmtpUrl')) { $SmtpUrl = Read-Host 'SMTP server URL (blank to set later)' }

$Domain = $Domain.Trim().ToLowerInvariant()
if ($Domain -notmatch '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$') {
  Fail "Domain `"$Domain`" is not a hostname. Use a name like idm.example.com, without scheme or port."
}
if ($Email -notmatch '^[^@\s]+@[^@\s]+$') { Fail "Email `"$Email`" is not an email address." }

# local: http on 127.0.0.1:8080. proxy: https through your own proxy to
# 127.0.0.1:8080. caddy: the docker-compose.tls.yml overlay.
if ($Domain -eq 'localhost' -or $Domain -like '*.localhost' -or $Domain -eq '127.0.0.1') { $mode = 'local' }
elseif ($OwnProxy) { $mode = 'proxy' } else { $mode = 'caddy' }
if ($mode -eq 'local') { $publicUrl = "http://${Domain}:8080" } else { $publicUrl = "https://$Domain" }
$smtpNote = -not $SmtpUrl
if ($smtpNote) { $SmtpUrl = 'smtp://localhost:25' }
$slug = (($Org.ToLowerInvariant() -replace '[^a-z0-9]+', '-').Trim('-'))
if (-not $slug) { $slug = 'syntra' }

$lines = @(
  "# Written by scripts/quickstart.ps1 on $((Get-Date).ToUniversalTime().ToString('yyyy-MM-dd HH:mm')) UTC.",
  '# Every variable is described in docs/configure.md.',
  ''
)
if ($mode -eq 'caddy') {
  $lines += @(
    '# Lets plain "docker compose ..." in this directory include the TLS overlay.',
    '# Append :docker-compose.override.yml if you create one.',
    'COMPOSE_PATH_SEPARATOR=:',
    'COMPOSE_FILE=docker-compose.yml:docker-compose.tls.yml'
  )
}
if ($Project) { $lines += "COMPOSE_PROJECT_NAME=$Project" }
$lines += ''
if ($Version) { $lines += "SYNTRA_VERSION=$Version" } else { $lines += '# SYNTRA_VERSION=1.19.1                 # unset runs :latest' }
$lines += "PUBLIC_URL=$publicUrl"
if ($mode -eq 'caddy') { $lines += "SYNTRA_DOMAIN=$Domain" }
$lines += @(
  '',
  '# BACK UP MASTER_KEY. It encrypts every stored credential and signs SAML.',
  '# Without it the database cannot be read back. Never change it by hand:',
  '# see docs/operate.md, "Runbooks: secret rotation".',
  "MASTER_KEY=$(New-Secret 32)",
  "SESSION_SECRET=$(New-Secret 32)",
  "POSTGRES_PASSWORD=$(New-Secret 32 -Hex)",
  "SYNTRA_APP_PASSWORD=$(New-Secret 32 -Hex)",
  '',
  "SMTP_URL=$SmtpUrl",
  '# MAIL_FROM=Syntra <syntra@example.com>'
)

# CreateNew refuses an existing file; UTF-8 without a BOM and LF line endings,
# which is what Compose reads.
$stream = [System.IO.File]::Open($envPath, [System.IO.FileMode]::CreateNew)
try {
  $bytes = (New-Object System.Text.UTF8Encoding $false).GetBytes(($lines -join "`n") + "`n")
  $stream.Write($bytes, 0, $bytes.Length)
} finally { $stream.Dispose() }
if ($IsLinux -or $IsMacOS) { chmod 600 $envPath }
else { icacls $envPath /inheritance:r /grant:r "$($env:USERNAME):F" | Out-Null }

Write-Host "Wrote $envPath (readable by $($env:USERNAME) only)."
Write-Host ''
Write-Host '  Back up MASTER_KEY from .env now, somewhere other than this host.' -ForegroundColor Yellow
Write-Host '  Losing it means re-entering every stored credential.' -ForegroundColor Yellow
Write-Host ''
if ($smtpNote) {
  Write-Host '  SMTP_URL is a placeholder: no mail is delivered. Set it in .env and run docker compose up -d.'
  Write-Host ''
}
if ($NoStart) { Write-Host 'Start it with: docker compose up -d'; exit 0 }

# Docker writes progress to stderr, which Windows PowerShell 5.1 turns into a
# terminating error under 'Stop' as soon as it is redirected. Exit codes are
# checked instead from here on.
$ErrorActionPreference = 'Continue'

if ($mode -eq 'caddy') { Write-Host "Caddy will request a certificate for $Domain. It must resolve to this host on ports 80 and 443." }
Write-Host 'Pulling images...'
docker compose pull --quiet
if ($LASTEXITCODE -ne 0) { Fail 'docker compose pull failed.' }
Write-Host 'Starting...'
docker compose up -d --wait --wait-timeout 300
if ($LASTEXITCODE -ne 0) { docker compose ps; Fail 'Stack did not become healthy within 5 minutes. See: docker compose logs api' }
Write-Host "Ready: $publicUrl"
if ($mode -eq 'proxy') { Write-Host "  Point your proxy for $Domain at http://127.0.0.1:8080 and pass the Host header through." }
Write-Host ''

if ($Bootstrap) {
  $adminPassword = (New-Secret 18).Replace('+', '-').Replace('/', '_')
  $env:BOOTSTRAP_TENANT_NAME = $Org; $env:BOOTSTRAP_TENANT_SLUG = $slug
  $env:BOOTSTRAP_TENANT_DOMAIN = $Domain; $env:BOOTSTRAP_ADMIN_EMAIL = $Email
  $env:BOOTSTRAP_ADMIN_PASSWORD = $adminPassword
  try {
    $out = docker compose exec -T -e BOOTSTRAP_TENANT_NAME -e BOOTSTRAP_TENANT_SLUG `
      -e BOOTSTRAP_TENANT_DOMAIN -e BOOTSTRAP_ADMIN_EMAIL -e BOOTSTRAP_ADMIN_PASSWORD `
      api pnpm --silent --filter '@syntra/db' bootstrap 2>&1
    $code = $LASTEXITCODE
  } finally {
    'BOOTSTRAP_TENANT_NAME', 'BOOTSTRAP_TENANT_SLUG', 'BOOTSTRAP_TENANT_DOMAIN', 'BOOTSTRAP_ADMIN_EMAIL', 'BOOTSTRAP_ADMIN_PASSWORD' |
      ForEach-Object { Remove-Item "env:$_" -ErrorAction SilentlyContinue }
  }
  if ($code -ne 0) { $out | Write-Host; Fail 'Bootstrap failed. The stack is running; see the bootstrap command in docs/install.md.' }
  if (($out -join "`n") -match 'Nothing to do') { Fail "Organization `"$slug`" already has an administrator. No password was set." }
  Write-Host "Created organization `"$Org`" (slug $slug)."
  Write-Host ''
  Write-Host "Sign in at $publicUrl"
  Write-Host '  Login:    admin'
  Write-Host "  Password: $adminPassword"
  Write-Host '  This password is shown once. Change it after signing in.'
  exit 0
}

$setup = docker compose logs --no-log-prefix api 2>$null | Select-String 'First-run setup' | Select-Object -Last 1
Write-Host 'Next: create your organization and first administrator.'
Write-Host ''
if ($setup) {
  Write-Host '  Open the First-run setup link from the API log:'
  Write-Host "    $setup"
} else {
  Write-Host '  If the API log shows a First-run setup link, open it:'
  Write-Host '    docker compose logs api | Select-String "First-run setup"'
  Write-Host ''
  Write-Host '  Otherwise run (choose a password of 12 or more characters):'
  Write-Host "    docker compose exec -e BOOTSTRAP_TENANT_NAME='$Org' -e BOOTSTRAP_TENANT_SLUG=$slug ``"
  Write-Host "      -e BOOTSTRAP_TENANT_DOMAIN=$Domain -e BOOTSTRAP_ADMIN_EMAIL=$Email ``"
  Write-Host "      -e BOOTSTRAP_ADMIN_PASSWORD='...' api pnpm --filter '@syntra/db' bootstrap"
  Write-Host ''
  Write-Host "  Then sign in at $publicUrl as admin."
}
