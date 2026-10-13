#!/bin/sh
# Installs or upgrades a self-hosted Job Matcher with Docker Compose.
#
#   curl -fsSL https://raw.githubusercontent.com/Karthik-beta/AI-Job-Resume-Matcher/master/install.sh | sh
#
# Environment overrides:
#   JOB_MATCHER_DIR             install directory (default: ~/job-matcher)
#   JOB_MATCHER_VERSION         release to install, e.g. 1.0.0 (default: the latest release)
#   JOB_MATCHER_REF             git ref to download compose.yml from (default: the release tag)
#   JOB_MATCHER_NONINTERACTIVE  set to 1 to skip prompts; reads OPENROUTER_API_KEY and
#                               FIRECRAWL_API_KEY from the environment instead
#
# Running it again upgrades to the newest release and keeps the existing .env.
set -eu

REPO="Karthik-beta/AI-Job-Resume-Matcher"
DIR="${JOB_MATCHER_DIR:-$HOME/job-matcher}"

if [ -t 1 ]; then
  BOLD=$(printf '\033[1m'); DIM=$(printf '\033[2m'); RED=$(printf '\033[31m'); GREEN=$(printf '\033[32m'); RESET=$(printf '\033[0m')
else
  BOLD=""; DIM=""; RED=""; GREEN=""; RESET=""
fi

say() { printf '%s\n' "$*"; }
step() { printf '%s==>%s %s\n' "$BOLD" "$RESET" "$*"; }
fail() { printf '%sError:%s %s\n' "$RED" "$RESET" "$*" >&2; exit 1; }

download() { # url dest
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$1" -o "$2"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$2" "$1"
  else
    fail "curl or wget is required."
  fi
}

fetch() { # url -> stdout
  if command -v curl >/dev/null 2>&1; then curl -fsSL "$1"; else wget -qO- "$1"; fi
}

random_secret() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  else
    od -An -tx1 -N32 /dev/urandom | tr -d ' \n'
  fi
}

port_in_use() {
  if command -v lsof >/dev/null 2>&1; then
    lsof -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1
  elif command -v ss >/dev/null 2>&1; then
    ss -ltn 2>/dev/null | awk '{print $4}' | grep -q "[:.]$1\$"
  elif command -v netstat >/dev/null 2>&1; then
    netstat -an 2>/dev/null | grep -i listen | grep -q "[:.]$1 "
  else
    return 1
  fi
}

# Prompts read from the terminal, so they work under `curl | sh` too.
ask() { # prompt -> stdout
  if [ "${JOB_MATCHER_NONINTERACTIVE:-0}" = 1 ] || ! [ -r /dev/tty ]; then
    return 0
  fi
  printf '%s' "$1" >/dev/tty
  IFS= read -r answer </dev/tty || answer=""
  printf '%s' "$answer"
}

set_env() { # key value: replace the key's line in .env
  tmp="$DIR/.env.tmp"
  awk -v k="$1" -v v="$2" 'BEGIN { done = 0 }
    index($0, k "=") == 1 { print k "=" v; done = 1; next }
    { print }
    END { if (!done) print k "=" v }' "$DIR/.env" >"$tmp"
  mv "$tmp" "$DIR/.env"
}

get_env() { # key -> value from .env
  sed -n "s/^$1=//p" "$DIR/.env" | tail -n 1
}

say ""
say "${BOLD}Job Matcher installer${RESET}"
say ""

# 1. Docker
step "Checking Docker"
command -v docker >/dev/null 2>&1 ||
  fail "Docker is not installed. Install Docker Desktop (https://docs.docker.com/get-docker/) and run this again."
docker compose version >/dev/null 2>&1 ||
  fail "Docker Compose v2 is missing. Update Docker (https://docs.docker.com/compose/install/) and run this again."
docker info >/dev/null 2>&1 ||
  fail "Docker is installed but not running. Start Docker Desktop (or the Docker service) and run this again."

# 2. Version
if [ -n "${JOB_MATCHER_VERSION:-}" ]; then
  VERSION="${JOB_MATCHER_VERSION#v}"
else
  step "Finding the latest release"
  VERSION=$(fetch "https://api.github.com/repos/$REPO/releases/latest" |
    sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"v\{0,1\}\([^"]*\)".*/\1/p' | head -n 1) || true
  [ -n "$VERSION" ] || fail "Could not find the latest release on GitHub. Set JOB_MATCHER_VERSION and run this again."
fi
# Compose files come from the release tag; a non-release version (e.g. a local test tag) uses master.
case "$VERSION" in
  [0-9]*.[0-9]*.[0-9]*) REF="${JOB_MATCHER_REF:-v$VERSION}" ;;
  *) REF="${JOB_MATCHER_REF:-master}" ;;
esac
say "    version ${BOLD}$VERSION${RESET}"

# 3. Files
step "Downloading the stack into $DIR"
mkdir -p "$DIR"
download "https://raw.githubusercontent.com/$REPO/$REF/deploy/compose.yml" "$DIR/compose.yml"
download "https://raw.githubusercontent.com/$REPO/$REF/deploy/.env.example" "$DIR/.env.example"

# 4. Settings
if [ -f "$DIR/.env" ]; then
  step "Keeping the existing settings in $DIR/.env"
  set_env JOB_MATCHER_VERSION "$VERSION"
else
  # A database left by an earlier install was created with that install's password.
  if docker volume inspect job-matcher_postgres-data >/dev/null 2>&1; then
    fail "A database from an earlier Job Matcher install exists, but its .env is gone. Restore that .env into $DIR, or delete the old data with: docker volume rm job-matcher_postgres-data job-matcher_redis-data"
  fi
  step "Creating settings"
  cp "$DIR/.env.example" "$DIR/.env"
  chmod 600 "$DIR/.env"

  port=8080
  while port_in_use "$port"; do port=$((port + 1)); done

  set_env POSTGRES_PASSWORD "$(random_secret)"
  set_env BETTER_AUTH_SECRET "$(random_secret)"
  set_env BETTER_AUTH_URL "http://localhost:$port"
  set_env WEB_PORT "$port"
  set_env JOB_MATCHER_VERSION "$VERSION"

  openrouter_key="${OPENROUTER_API_KEY:-}"
  firecrawl_key="${FIRECRAWL_API_KEY:-}"
  if [ "${JOB_MATCHER_NONINTERACTIVE:-0}" != 1 ] && [ -r /dev/tty ]; then
    say ""
    say "  Job Matcher needs two API keys to scrape real job boards:"
    say "    OpenRouter (AI matching):  https://openrouter.ai/keys"
    say "    Firecrawl  (web scraping): https://www.firecrawl.dev/app/api-keys  ${DIM}(free plan available)${RESET}"
    say "  Press Enter to skip both and try demo mode first. You can add keys later."
    say ""
    [ -n "$openrouter_key" ] || openrouter_key=$(ask "  OpenRouter API key: ")
    if [ -n "$openrouter_key" ] && [ -z "$firecrawl_key" ]; then
      firecrawl_key=$(ask "  Firecrawl API key:  ")
    fi
    say ""
  fi

  if [ -n "$openrouter_key" ] && [ -n "$firecrawl_key" ]; then
    set_env OPENROUTER_API_KEY "$openrouter_key"
    set_env FIRECRAWL_API_KEY "$firecrawl_key"
    set_env PROVIDERS live
  else
    [ -z "$openrouter_key$firecrawl_key" ] || say "  Live mode needs both keys; starting in demo mode."
    set_env PROVIDERS fake
  fi
fi

# 5. Start
cd "$DIR"
step "Starting Job Matcher (the first start downloads the images and takes a few minutes)"
# -f wins over a COMPOSE_FILE that may be set in the caller's shell.
docker compose -f "$DIR/compose.yml" up -d --pull missing --quiet-pull --remove-orphans --wait --wait-timeout 300 ||
  fail "The stack did not become healthy. See the logs with: cd \"$DIR\" && docker compose logs"

PORT=$(get_env WEB_PORT)
URL=$(get_env BETTER_AUTH_URL)
MODE=$(get_env PROVIDERS)

say ""
say "${GREEN}${BOLD}Job Matcher is running at ${URL:-http://localhost:${PORT:-8080}}${RESET}"
if [ "$MODE" = live ]; then
  say "Mode: live. Sign up, add your job sources and resume in Settings, then press Analyze."
else
  say "Mode: demo (sample pages, no API keys). Sign up, add any careers page and resume URL in"
  say "Settings, then press Analyze. To go live, add both keys to $DIR/.env, set PROVIDERS=live,"
  say "and run: cd \"$DIR\" && docker compose up -d"
fi
say ""
say "${DIM}Logs:      cd \"$DIR\" && docker compose logs -f${RESET}"
say "${DIM}Stop:      cd \"$DIR\" && docker compose stop${RESET}"
say "${DIM}Upgrade:   run this installer again${RESET}"
say "${DIM}Uninstall: cd \"$DIR\" && docker compose down -v, then delete the folder${RESET}"
say ""
