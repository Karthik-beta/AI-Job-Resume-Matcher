# Installs or upgrades a self-hosted Job Matcher with Docker Compose, on Windows.
#
#   irm https://raw.githubusercontent.com/Karthik-beta/AI-Job-Resume-Matcher/master/install.ps1 | iex
#
# Environment overrides:
#   JOB_MATCHER_DIR             install directory (default: ~\job-matcher)
#   JOB_MATCHER_VERSION         release to install, e.g. 1.0.0 (default: the latest release)
#   JOB_MATCHER_REF             git ref to download compose.yml from (default: the release tag)
#   JOB_MATCHER_NONINTERACTIVE  set to 1 to skip prompts; reads OPENROUTER_API_KEY and
#                               FIRECRAWL_API_KEY from the environment instead
#
# Running it again upgrades to the newest release and keeps the existing .env.
# Wrapped in a script block so `iex` does not leak variables or exit the caller's shell.
& {
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue'

  $Repo = 'Karthik-beta/AI-Job-Resume-Matcher'
  $Dir = if ($env:JOB_MATCHER_DIR) { $env:JOB_MATCHER_DIR } else { Join-Path $HOME 'job-matcher' }
  $EnvFile = Join-Path $Dir '.env'
  $Interactive = $env:JOB_MATCHER_NONINTERACTIVE -ne '1'

  function Step($Text) { Write-Host '==> ' -NoNewline -ForegroundColor Cyan; Write-Host $Text }
  function Fail($Text) { Write-Host "Error: $Text" -ForegroundColor Red; throw 'Job Matcher install failed.' }

  function New-Secret {
    $bytes = [byte[]]::new(32)
    # Create().GetBytes works on Windows PowerShell 5.1 (.NET Framework) as well as PowerShell 7.
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    -join ($bytes | ForEach-Object { $_.ToString('x2') })
  }

  function Test-PortInUse([int]$Port) {
    $listeners = [System.Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners()
    [bool]($listeners | Where-Object { $_.Port -eq $Port })
  }

  # .env is read and written as LF-terminated UTF-8 without a BOM, which Compose expects.
  function Read-EnvLines { [System.IO.File]::ReadAllText($EnvFile) -split "`n" }
  function Write-EnvLines($Lines) {
    [System.IO.File]::WriteAllText($EnvFile, ($Lines -join "`n"), [System.Text.UTF8Encoding]::new($false))
  }
  function Set-EnvValue($Key, $Value) {
    $lines = Read-EnvLines
    $found = $false
    $lines = foreach ($line in $lines) {
      if ($line.StartsWith("$Key=")) { "$Key=$Value"; $found = $true } else { $line }
    }
    if (-not $found) { $lines = @($lines) + "$Key=$Value" }
    Write-EnvLines $lines
  }
  function Get-EnvValue($Key) {
    $line = Read-EnvLines | Where-Object { $_.StartsWith("$Key=") } | Select-Object -Last 1
    if ($line) { $line.Substring($Key.Length + 1).Trim() } else { '' }
  }

  function Invoke-Docker {
    & docker @args
    if ($LASTEXITCODE -ne 0) { throw "docker $($args -join ' ') failed" }
  }

  Write-Host ''
  Write-Host 'Job Matcher installer' -ForegroundColor White
  Write-Host ''

  # 1. Docker
  Step 'Checking Docker'
  if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    Fail 'Docker is not installed. Install Docker Desktop (https://docs.docker.com/desktop/setup/install/windows-install/) and run this again.'
  }
  docker compose version *> $null
  if ($LASTEXITCODE -ne 0) { Fail 'Docker Compose v2 is missing. Update Docker Desktop and run this again.' }
  docker info *> $null
  if ($LASTEXITCODE -ne 0) { Fail 'Docker is installed but not running. Start Docker Desktop and run this again.' }

  # 2. Version
  if ($env:JOB_MATCHER_VERSION) {
    $Version = $env:JOB_MATCHER_VERSION.TrimStart('v')
  } else {
    Step 'Finding the latest release'
    try {
      $release = Invoke-RestMethod "https://api.github.com/repos/$Repo/releases/latest" -Headers @{ 'User-Agent' = 'job-matcher-installer' }
      $Version = $release.tag_name.TrimStart('v')
    } catch {
      Fail 'Could not find the latest release on GitHub. Set $env:JOB_MATCHER_VERSION and run this again.'
    }
  }
  # Compose files come from the release tag; a non-release version (e.g. a local test tag) uses master.
  $Ref = if ($env:JOB_MATCHER_REF) { $env:JOB_MATCHER_REF } elseif ($Version -match '^\d+\.\d+\.\d+') { "v$Version" } else { 'master' }
  Write-Host "    version $Version"

  # 3. Files
  Step "Downloading the stack into $Dir"
  New-Item -ItemType Directory -Force -Path $Dir | Out-Null
  $raw = "https://raw.githubusercontent.com/$Repo/$Ref/deploy"
  Invoke-WebRequest "$raw/compose.yml" -OutFile (Join-Path $Dir 'compose.yml') -UseBasicParsing
  Invoke-WebRequest "$raw/.env.example" -OutFile (Join-Path $Dir '.env.example') -UseBasicParsing

  # 4. Settings
  if (Test-Path $EnvFile) {
    Step "Keeping the existing settings in $EnvFile"
    Set-EnvValue 'JOB_MATCHER_VERSION' $Version
  } else {
    # A database left by an earlier install was created with that install's password.
    docker volume inspect job-matcher_postgres-data *> $null
    if ($LASTEXITCODE -eq 0) {
      Fail "A database from an earlier Job Matcher install exists, but its .env is gone. Restore that .env into $Dir, or delete the old data with: docker volume rm job-matcher_postgres-data job-matcher_redis-data"
    }
    Step 'Creating settings'
    Copy-Item (Join-Path $Dir '.env.example') $EnvFile

    $port = 8080
    while (Test-PortInUse $port) { $port++ }

    Set-EnvValue 'POSTGRES_PASSWORD' (New-Secret)
    Set-EnvValue 'BETTER_AUTH_SECRET' (New-Secret)
    Set-EnvValue 'BETTER_AUTH_URL' "http://localhost:$port"
    Set-EnvValue 'WEB_PORT' $port
    Set-EnvValue 'JOB_MATCHER_VERSION' $Version

    $openrouterKey = "$env:OPENROUTER_API_KEY"
    $firecrawlKey = "$env:FIRECRAWL_API_KEY"
    if ($Interactive) {
      Write-Host ''
      Write-Host '  Job Matcher needs two API keys to scrape real job boards:'
      Write-Host '    OpenRouter (AI matching):  https://openrouter.ai/keys'
      Write-Host '    Firecrawl  (web scraping): https://www.firecrawl.dev/app/api-keys  (free plan available)'
      Write-Host '  Press Enter to skip both and try demo mode first. You can add keys later.'
      Write-Host ''
      if (-not $openrouterKey) { $openrouterKey = (Read-Host '  OpenRouter API key').Trim() }
      if ($openrouterKey -and -not $firecrawlKey) { $firecrawlKey = (Read-Host '  Firecrawl API key ').Trim() }
      Write-Host ''
    }

    if ($openrouterKey -and $firecrawlKey) {
      Set-EnvValue 'OPENROUTER_API_KEY' $openrouterKey
      Set-EnvValue 'FIRECRAWL_API_KEY' $firecrawlKey
      Set-EnvValue 'PROVIDERS' 'live'
    } else {
      if ($openrouterKey -or $firecrawlKey) { Write-Host '  Live mode needs both keys; starting in demo mode.' }
      Set-EnvValue 'PROVIDERS' 'fake'
    }
  }

  # 5. Start
  Push-Location $Dir
  try {
    Step 'Starting Job Matcher (the first start downloads the images and takes a few minutes)'
    try {
      # -f wins over a COMPOSE_FILE that may be set in the caller's shell.
      Invoke-Docker compose -f (Join-Path $Dir 'compose.yml') up -d --pull missing --quiet-pull --remove-orphans --wait --wait-timeout 300
    } catch {
      Fail "The stack did not become healthy. See the logs with: cd `"$Dir`"; docker compose logs"
    }
  } finally {
    Pop-Location
  }

  $url = Get-EnvValue 'BETTER_AUTH_URL'
  $mode = Get-EnvValue 'PROVIDERS'

  Write-Host ''
  Write-Host "Job Matcher is running at $url" -ForegroundColor Green
  if ($mode -eq 'live') {
    Write-Host 'Mode: live. Sign up, add your job sources and resume in Settings, then press Analyze.'
  } else {
    Write-Host 'Mode: demo (sample pages, no API keys). Sign up, add any careers page and resume URL in'
    Write-Host "Settings, then press Analyze. To go live, add both keys to $EnvFile, set PROVIDERS=live,"
    Write-Host "and run: cd `"$Dir`"; docker compose up -d"
  }
  Write-Host ''
  Write-Host "Logs:      cd `"$Dir`"; docker compose logs -f" -ForegroundColor DarkGray
  Write-Host "Stop:      cd `"$Dir`"; docker compose stop" -ForegroundColor DarkGray
  Write-Host 'Upgrade:   run this installer again' -ForegroundColor DarkGray
  Write-Host "Uninstall: cd `"$Dir`"; docker compose down -v, then delete the folder" -ForegroundColor DarkGray
  Write-Host ''

  if ($Interactive) { Start-Process $url }
}
