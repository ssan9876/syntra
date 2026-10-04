#!/bin/sh
# Syntra quickstart: writes a .env with generated secrets beside
# docker-compose.yml, starts the stack and waits for it to be ready.
#
#   scripts/quickstart.sh                                  # asks for what it needs
#   scripts/quickstart.sh --domain localhost --email you@example.com
#   scripts/quickstart.sh --domain idm.example.com --email you@example.com \
#     --smtp-url smtp://mail.example.com:25 --version 1.19.1
#
# See docs/install.md, "Quickstart".

set -eu

usage() {
  cat <<'EOF'
Usage: scripts/quickstart.sh [options]

  --domain NAME      Hostname people will use. "localhost" (the default) runs
                     on http://localhost:8080; any other name runs Caddy with a
                     Let's Encrypt certificate on ports 80 and 443.
  --own-proxy        With a real --domain: no Caddy. Your own TLS proxy on this
                     host forwards https://NAME to 127.0.0.1:8080.
  --email ADDRESS    The first administrator's email address.
  --smtp-url URL     Outgoing mail server, e.g. smtp://mail.example.com:25.
                     Unset, mail is not delivered until you set SMTP_URL.
  --version X.Y.Z    Release to run (SYNTRA_VERSION). Unset runs :latest.
  --org NAME         Organization name, used by --bootstrap. Default "Syntra".
  --project NAME     Compose project name (COMPOSE_PROJECT_NAME).
  --bootstrap        Create the organization and first administrator now, with
                     a generated password, instead of in the browser.
  --no-start         Write .env and stop.
  -h, --help         Show this help.
EOF
}

die() {
  echo "quickstart: $*" >&2
  exit 1
}

domain=''
email=''
smtp_url=''
version=''
org='Syntra'
project=''
bootstrap=0
start=1
own_proxy=0

while [ $# -gt 0 ]; do
  case "$1" in
    --domain) [ $# -ge 2 ] || die "--domain needs a value."; domain=$2; shift 2 ;;
    --domain=*) domain=${1#*=}; shift ;;
    --email) [ $# -ge 2 ] || die "--email needs a value."; email=$2; shift 2 ;;
    --email=*) email=${1#*=}; shift ;;
    --smtp-url) [ $# -ge 2 ] || die "--smtp-url needs a value."; smtp_url=$2; shift 2 ;;
    --smtp-url=*) smtp_url=${1#*=}; shift ;;
    --version) [ $# -ge 2 ] || die "--version needs a value."; version=$2; shift 2 ;;
    --version=*) version=${1#*=}; shift ;;
    --org) [ $# -ge 2 ] || die "--org needs a value."; org=$2; shift 2 ;;
    --org=*) org=${1#*=}; shift ;;
    --project) [ $# -ge 2 ] || die "--project needs a value."; project=$2; shift 2 ;;
    --project=*) project=${1#*=}; shift ;;
    --bootstrap) bootstrap=1; shift ;;
    --own-proxy) own_proxy=1; shift ;;
    --no-start) start=0; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; die "Unknown option: $1" ;;
  esac
done

# The directory holding docker-compose.yml: the checkout this script is in.
root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
cd "$root"
[ -f docker-compose.yml ] || die "docker-compose.yml not found in $root."

if [ -e .env ]; then
  die ".env already exists in $root. Not overwritten. Start the existing install with: docker compose up -d"
fi

command -v docker >/dev/null 2>&1 || die "docker not found. Install Docker first: https://docs.docker.com/engine/install/"
docker compose version >/dev/null 2>&1 || die "docker compose not found. Install the Docker Compose plugin (v2.24 or later)."

ask() {
  # ask VAR "Prompt" "default"
  if [ -t 0 ]; then
    if [ -n "$3" ]; then printf '%s [%s]: ' "$2" "$3"; else printf '%s: ' "$2"; fi
    read -r answer || answer=''
    [ -n "$answer" ] || answer=$3
    eval "$1=\$answer"
  fi
}

[ -n "$domain" ] || ask domain 'Domain (localhost to try it on this machine)' 'localhost'
[ -n "$domain" ] || domain=localhost
[ -n "$email" ] || ask email "First administrator's email" ''
if [ -z "$smtp_url" ] && [ -t 0 ]; then
  ask smtp_url 'SMTP server URL (blank to set later)' ''
fi

domain=$(printf '%s' "$domain" | tr '[:upper:]' '[:lower:]')
printf '%s' "$domain" | grep -Eq '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$' \
  || die "Domain \"$domain\" is not a hostname. Use a name like idm.example.com, without scheme or port."
[ -n "$email" ] || die "Administrator email is required. Pass --email you@example.com."
printf '%s' "$email" | grep -Eq '^[^@[:space:]]+@[^@[:space:]]+$' \
  || die "Email \"$email\" is not an email address."
if [ -n "$version" ]; then
  printf '%s' "$version" | grep -Eq '^[0-9]+(\.[0-9]+)*(-[0-9A-Za-z.]+)?$' \
    || die "Version \"$version\" is not a release number. Use the number without the v, e.g. 1.19.1."
fi

# local: http on 127.0.0.1:8080. proxy: https through the operator's own
# proxy to 127.0.0.1:8080. caddy: the docker-compose.tls.yml overlay.
case "$domain" in
  localhost|*.localhost|127.0.0.1) mode=local ;;
  *) if [ "$own_proxy" -eq 1 ]; then mode=proxy; else mode=caddy; fi ;;
esac

# Secrets. Hex for the two database passwords, because SYNTRA_APP_PASSWORD is
# spliced into a postgresql:// URL and base64's + / = would break it. The \r
# is for Git Bash on Windows, whose openssl ends its output with CRLF.
rand_hex() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32 | tr -d '\r\n'
  else
    od -An -tx1 -N32 /dev/urandom | tr -d ' \r\n'
  fi
}
rand_b64() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -base64 "$1" | tr -d '\r\n'
  else
    head -c "$1" /dev/urandom | base64 | tr -d '\r\n'
  fi
}

slugify() {
  slug=$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]' \
    | sed -e 's/[^a-z0-9]\{1,\}/-/g' -e 's/^-//' -e 's/-$//' | cut -c1-63)
  [ -n "$slug" ] || slug=syntra
  printf '%s' "$slug"
}
slug=$(slugify "$org")

postgres_password=$(rand_hex)
app_password=$(rand_hex)
session_secret=$(rand_b64 32)
master_key=$(rand_b64 32)
[ ${#postgres_password} -eq 64 ] && [ ${#master_key} -eq 44 ] \
  || die "Generating secrets failed. Install openssl and run again."

if [ "$mode" = local ]; then
  public_url="http://$domain:8080"
else
  public_url="https://$domain"
fi

if [ -z "$smtp_url" ]; then
  smtp_url='smtp://localhost:25'
  smtp_note=1
else
  smtp_note=0
fi

# Created empty with mode 600 before any secret is written into it, and
# never over an existing file (noclobber).
umask 077
( set -C; : > .env ) 2>/dev/null || die ".env could not be created in $root."
chmod 600 .env

{
  echo "# Written by scripts/quickstart.sh on $(date -u '+%Y-%m-%d %H:%M UTC')."
  echo '# Every variable is described in docs/configure.md.'
  echo ''
  if [ "$mode" = caddy ]; then
    # Set, COMPOSE_FILE replaces the default file list: a
    # docker-compose.override.yml is only read once it is added here too.
    echo '# Lets plain "docker compose ..." in this directory include the TLS overlay.'
    echo '# Append :docker-compose.override.yml if you create one.'
    echo 'COMPOSE_PATH_SEPARATOR=:'
    echo 'COMPOSE_FILE=docker-compose.yml:docker-compose.tls.yml'
  fi
  if [ -n "$project" ]; then echo "COMPOSE_PROJECT_NAME=$project"; fi
  echo ''
  if [ -n "$version" ]; then
    echo "SYNTRA_VERSION=$version"
  else
    echo '# SYNTRA_VERSION=1.19.1                 # unset runs :latest'
  fi
  echo "PUBLIC_URL=$public_url"
  if [ "$mode" = caddy ]; then echo "SYNTRA_DOMAIN=$domain"; fi
  echo ''
  echo '# BACK UP MASTER_KEY. It encrypts every stored credential and signs SAML.'
  echo '# Without it the database cannot be read back. Never change it by hand:'
  echo '# see docs/operate.md, "Runbooks: secret rotation".'
  echo "MASTER_KEY=$master_key"
  echo "SESSION_SECRET=$session_secret"
  echo "POSTGRES_PASSWORD=$postgres_password"
  echo "SYNTRA_APP_PASSWORD=$app_password"
  echo ''
  echo "SMTP_URL=$smtp_url"
  echo '# MAIL_FROM=Syntra <syntra@example.com>'
} >> .env

echo "Wrote $root/.env (mode 600)."
echo ''
echo '  Back up MASTER_KEY from .env now, somewhere other than this host.'
echo '  Losing it means re-entering every stored credential.'
echo ''
if [ "$smtp_note" -eq 1 ]; then
  echo '  SMTP_URL is a placeholder: no mail is delivered. Set it in .env and'
  echo '  run docker compose up -d.'
  echo ''
fi

if [ "$start" -eq 0 ]; then
  echo 'Start it with: docker compose up -d'
  exit 0
fi

if [ "$mode" = caddy ]; then
  echo "Caddy will request a certificate for $domain. It must resolve to this host on ports 80 and 443."
fi

echo 'Pulling images...'
docker compose pull --quiet
echo 'Starting...'
# --wait returns once every service with a healthcheck is healthy; the api's
# healthcheck is /health/ready (database, migrations, master key).
if ! docker compose up -d --wait --wait-timeout 300; then
  docker compose ps >&2 || true
  die "Stack did not become healthy within 5 minutes. See: docker compose logs api"
fi
if [ "$mode" != caddy ] && command -v curl >/dev/null 2>&1; then
  curl -fsS -o /dev/null "http://127.0.0.1:8080/health/ready" \
    || die "Stack started but http://127.0.0.1:8080/health/ready did not answer. See: docker compose logs web api"
fi
echo "Ready: $public_url"
if [ "$mode" = proxy ]; then
  echo "  Point your proxy for $domain at http://127.0.0.1:8080 and pass the Host header through."
fi
echo ''

if [ "$bootstrap" -eq 1 ]; then
  admin_password=$(rand_b64 18 | tr '+/' '-_')
  # The password reaches the container through the environment, not argv.
  if ! out=$(BOOTSTRAP_TENANT_NAME=$org BOOTSTRAP_TENANT_SLUG=$slug \
      BOOTSTRAP_TENANT_DOMAIN=$domain BOOTSTRAP_ADMIN_EMAIL=$email \
      BOOTSTRAP_ADMIN_PASSWORD=$admin_password \
      docker compose exec -T \
        -e BOOTSTRAP_TENANT_NAME -e BOOTSTRAP_TENANT_SLUG -e BOOTSTRAP_TENANT_DOMAIN \
        -e BOOTSTRAP_ADMIN_EMAIL -e BOOTSTRAP_ADMIN_PASSWORD \
        api pnpm --silent --filter @syntra/db bootstrap 2>&1); then
    echo "$out" >&2
    die "Bootstrap failed. The stack is running; see the bootstrap command in docs/install.md."
  fi
  case "$out" in
    *'Nothing to do'*) die "Organization \"$slug\" already has an administrator. No password was set." ;;
  esac
  echo "Created organization \"$org\" (slug $slug)."
  echo ''
  echo "Sign in at $public_url"
  echo '  Login:    admin'
  echo "  Password: $admin_password"
  echo '  This password is shown once. Change it after signing in.'
  exit 0
fi

setup=$(docker compose logs --no-log-prefix api 2>/dev/null | grep 'First-run setup' | tail -n 1 || true)
echo 'Next: create your organization and first administrator.'
echo ''
if [ -n "$setup" ]; then
  echo "  Open the First-run setup link from the API log:"
  echo "    $setup"
else
  echo '  If the API log shows a First-run setup link, open it:'
  echo '    docker compose logs api | grep "First-run setup"'
  echo ''
  echo '  Otherwise run (choose a password of 12 or more characters):'
  echo "    docker compose exec \\"
  echo "      -e BOOTSTRAP_TENANT_NAME='$org' -e BOOTSTRAP_TENANT_SLUG=$slug \\"
  echo "      -e BOOTSTRAP_TENANT_DOMAIN=$domain -e BOOTSTRAP_ADMIN_EMAIL=$email \\"
  echo "      -e BOOTSTRAP_ADMIN_PASSWORD='...' \\"
  echo '      api pnpm --filter @syntra/db bootstrap'
  echo ''
  echo "  Then sign in at $public_url as admin."
fi
