#!/usr/bin/env bash
#
# Syntra in a Proxmox VE LXC container.
#
# Run on the Proxmox host, as root:
#
#   curl -fsSL https://raw.githubusercontent.com/ssan9876/syntra/main/deploy/proxmox/syntra-lxc.sh -o syntra-lxc.sh
#   bash syntra-lxc.sh --domain idm.example.com --email you@example.com
#
# It creates an unprivileged Debian 13 container, installs Docker from
# Docker's own apt repository, unpacks a release tarball (checksum verified)
# into /opt/syntra and runs scripts/quickstart.sh there. The result is the
# ordinary Compose install from docs/install.md, so everything in that
# document and in docs/operate.md applies to it unchanged.
#
# Two ways in front of it, chosen with --tls:
#
#   proxy (default)  web listens on <container IP>:8080, plain HTTP, for a
#                    reverse proxy on ANOTHER host (nginx, NPM, Traefik, a
#                    Cloudflare tunnel). --allow-from limits who may connect.
#   caddy            Caddy in the container gets a Let's Encrypt certificate.
#                    The name must resolve to the container on 80 and 443.
#
# Every option can also be given as an environment variable (SYNTRA_DOMAIN,
# SYNTRA_EMAIL, CTID, ...); flags win. `bash syntra-lxc.sh --help` lists them.
# See deploy/proxmox/README.md.

set -euo pipefail

REPO=ssan9876/syntra

# --- options ------------------------------------------------------------------

CTID=${CTID:-}
CT_HOSTNAME=${CT_HOSTNAME:-syntra}
CORES=${CORES:-2}
MEMORY=${MEMORY:-4096}
SWAP=${SWAP:-512}
DISK=${DISK:-20}
STORAGE=${STORAGE:-}
TEMPLATE_STORAGE=${TEMPLATE_STORAGE:-}
BRIDGE=${BRIDGE:-vmbr0}
VLAN=${VLAN:-}
IP=${IP:-dhcp}
GATEWAY=${GATEWAY:-}
DNS=${DNS:-}
SSH_KEY=${SSH_KEY:-}
DOMAIN=${SYNTRA_DOMAIN:-}
EMAIL=${SYNTRA_EMAIL:-}
SMTP_URL=${SYNTRA_SMTP_URL:-}
VERSION=${SYNTRA_VERSION:-}
ORG=${SYNTRA_ORG:-}
TLS=${SYNTRA_TLS:-proxy}
ALLOW_FROM=${SYNTRA_ALLOW_FROM:-}
YES=0

usage() {
  cat <<'EOF'
Usage: bash syntra-lxc.sh --domain NAME --email ADDRESS [options]

Syntra
  --domain NAME        Hostname people will use, e.g. idm.example.com.
  --email ADDRESS      The first administrator's email address.
  --tls proxy|caddy    proxy (default): plain HTTP on <container IP>:8080 for a
                       reverse proxy on another host. caddy: Let's Encrypt
                       inside the container; needs ports 80 and 443 from the
                       internet.
  --allow-from CIDRS   proxy mode: only these addresses may connect to :8080,
                       comma-separated, e.g. 192.168.1.10/32. Unset: anyone
                       who can route to the container.
  --version X.Y.Z      Release to install. Default: the latest release.
  --smtp-url URL       Outgoing mail, e.g. smtp://mail.example.com:25.
  --org NAME           Create the organization and first administrator now,
                       with a generated password printed once. Without it,
                       open the first-run link the script prints.

Container
  --ctid N             Container ID. Default: the next free ID.
  --hostname NAME      Default: syntra.
  --cores N            Default: 2.
  --memory MB          Default: 4096.
  --disk GB            Default: 20.
  --storage NAME       Storage for the root disk. Default: var_container_storage
                       from community-scripts' default.vars, else local-lvm.
  --template-storage NAME
                       Storage for the Debian template. Default: local.
  --bridge NAME        Default: vmbr0.
  --vlan TAG           VLAN tag on the bridge.
  --ip dhcp|CIDR       Default: dhcp. Static: --ip 192.168.1.50/24 --gateway 192.168.1.1.
  --gateway ADDRESS    Required with a static --ip.
  --dns "A B"          Nameservers. Default: the host's.
  --ssh-key FILE       Public key(s) for root in the container.

  -y, --yes            Do not ask for confirmation.
  -h, --help           Show this help.
EOF
}

msg() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
die() { printf 'syntra-lxc: %s\n' "$*" >&2; exit 1; }

need_value() { [ "$2" -ge 2 ] || die "$1 needs a value."; }

while [ $# -gt 0 ]; do
  case "$1" in
    --domain)           need_value "$1" $#; DOMAIN=$2; shift 2 ;;
    --email)            need_value "$1" $#; EMAIL=$2; shift 2 ;;
    --tls)              need_value "$1" $#; TLS=$2; shift 2 ;;
    --allow-from)       need_value "$1" $#; ALLOW_FROM=$2; shift 2 ;;
    --version)          need_value "$1" $#; VERSION=$2; shift 2 ;;
    --smtp-url)         need_value "$1" $#; SMTP_URL=$2; shift 2 ;;
    --org)              need_value "$1" $#; ORG=$2; shift 2 ;;
    --ctid)             need_value "$1" $#; CTID=$2; shift 2 ;;
    --hostname)         need_value "$1" $#; CT_HOSTNAME=$2; shift 2 ;;
    --cores)            need_value "$1" $#; CORES=$2; shift 2 ;;
    --memory)           need_value "$1" $#; MEMORY=$2; shift 2 ;;
    --disk)             need_value "$1" $#; DISK=$2; shift 2 ;;
    --storage)          need_value "$1" $#; STORAGE=$2; shift 2 ;;
    --template-storage) need_value "$1" $#; TEMPLATE_STORAGE=$2; shift 2 ;;
    --bridge)           need_value "$1" $#; BRIDGE=$2; shift 2 ;;
    --vlan)             need_value "$1" $#; VLAN=$2; shift 2 ;;
    --ip)               need_value "$1" $#; IP=$2; shift 2 ;;
    --gateway)          need_value "$1" $#; GATEWAY=$2; shift 2 ;;
    --dns)              need_value "$1" $#; DNS=$2; shift 2 ;;
    --ssh-key)          need_value "$1" $#; SSH_KEY=$2; shift 2 ;;
    -y|--yes)           YES=1; shift ;;
    -h|--help)          usage; exit 0 ;;
    *)                  usage >&2; die "Unknown option: $1" ;;
  esac
done

# --- checks -------------------------------------------------------------------

[ "$(id -u)" -eq 0 ] || die "Run as root on the Proxmox host."
for cmd in pct pveam pvesh pvesm curl sha256sum tar; do
  command -v "$cmd" >/dev/null 2>&1 || die "$cmd not found. Run this on a Proxmox VE host."
done

ask() {
  # ask VAR "Prompt" "default" -- only with a terminal; otherwise keeps the value.
  local answer
  if [ -t 0 ]; then
    if [ -n "$3" ]; then printf '%s [%s]: ' "$2" "$3"; else printf '%s: ' "$2"; fi
    read -r answer || answer=''
    [ -n "$answer" ] || answer=$3
    printf -v "$1" '%s' "$answer"
  fi
}

[ -n "$DOMAIN" ] || ask DOMAIN 'Hostname people will use (e.g. idm.example.com)' ''
[ -n "$EMAIL" ]  || ask EMAIL "First administrator's email" ''

DOMAIN=$(printf '%s' "$DOMAIN" | tr '[:upper:]' '[:lower:]')
[ -n "$DOMAIN" ] || die "--domain is required, e.g. --domain idm.example.com."
printf '%s' "$DOMAIN" | grep -Eq '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$' \
  || die "Domain \"$DOMAIN\" is not a hostname. Use a name like idm.example.com, without scheme or port."
[ -n "$EMAIL" ] || die "--email is required."
printf '%s' "$EMAIL" | grep -Eq '^[^@[:space:]]+@[^@[:space:]]+$' || die "Email \"$EMAIL\" is not an email address."

case "$TLS" in
  proxy|caddy) ;;
  *) die "--tls must be proxy or caddy, not \"$TLS\"." ;;
esac
if [ -n "$ALLOW_FROM" ]; then
  [ "$TLS" = proxy ] || die "--allow-from applies to --tls proxy only."
  ALLOW_FROM=$(printf '%s' "$ALLOW_FROM" | tr ',' ' ')
  for c in $ALLOW_FROM; do
    printf '%s' "$c" | grep -Eq '^[0-9]{1,3}(\.[0-9]{1,3}){3}(/[0-9]{1,2})?$' \
      || die "--allow-from entry \"$c\" is not an IPv4 address or CIDR."
  done
fi

for pair in "cores:$CORES" "memory:$MEMORY" "disk:$DISK" "swap:$SWAP"; do
  printf '%s' "${pair#*:}" | grep -Eq '^[0-9]+$' || die "--${pair%%:*} must be a whole number, not \"${pair#*:}\"."
done
[ -z "$VLAN" ] || printf '%s' "$VLAN" | grep -Eq '^[0-9]+$' || die "--vlan must be a number."

if [ "$IP" != dhcp ]; then
  printf '%s' "$IP" | grep -Eq '^[0-9]{1,3}(\.[0-9]{1,3}){3}/[0-9]{1,2}$' \
    || die "--ip must be dhcp or an address with prefix, e.g. 192.168.1.50/24."
  [ -n "$GATEWAY" ] || die "--gateway is required with a static --ip."
fi
[ -z "$SSH_KEY" ] || [ -r "$SSH_KEY" ] || die "SSH key file $SSH_KEY cannot be read."

# community-scripts writes its storage choices here; reuse them when present.
DEFAULT_VARS=/usr/local/community-scripts/default.vars
vars_value() { [ -r "$DEFAULT_VARS" ] && sed -n "s/^$1=//p" "$DEFAULT_VARS" | tail -1; true; }
storages_for() { pvesm status -content "$1" 2>/dev/null | awk 'NR>1 && $3=="active" {print $1}'; }

[ -n "$STORAGE" ] || STORAGE=$(vars_value var_container_storage)
if [ -z "$STORAGE" ]; then
  if storages_for rootdir | grep -x local-lvm >/dev/null; then STORAGE=local-lvm; else STORAGE=$(storages_for rootdir | sed -n 1p); fi
fi
storages_for rootdir | grep -x "$STORAGE" >/dev/null || die "Storage \"$STORAGE\" does not hold containers. Pick one with --storage: $(storages_for rootdir | tr '\n' ' ')"

[ -n "$TEMPLATE_STORAGE" ] || TEMPLATE_STORAGE=$(vars_value var_template_storage)
[ -n "$TEMPLATE_STORAGE" ] || TEMPLATE_STORAGE=local
storages_for vztmpl | grep -x "$TEMPLATE_STORAGE" >/dev/null || die "Storage \"$TEMPLATE_STORAGE\" does not hold templates. Pick one with --template-storage: $(storages_for vztmpl | tr '\n' ' ')"

ip link show "$BRIDGE" >/dev/null 2>&1 || die "Bridge $BRIDGE does not exist on this host. Pick one with --bridge."

if [ -z "$CTID" ]; then
  CTID=$(pvesh get /cluster/nextid)
else
  printf '%s' "$CTID" | grep -Eq '^[0-9]+$' || die "--ctid must be a number."
  pvesh get /cluster/nextid --vmid "$CTID" >/dev/null 2>&1 || die "ID $CTID is already in use. Pick another with --ctid."
fi

latest_release() {
  curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" \
    | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"v\{0,1\}\([^"]*\)".*/\1/p' | head -1
}
if [ -z "$VERSION" ]; then
  VERSION=$(latest_release) || true
  [ -n "$VERSION" ] || die "Latest release of $REPO could not be read from GitHub. Pass --version X.Y.Z."
fi
VERSION=${VERSION#v}
printf '%s' "$VERSION" | grep -Eq '^[0-9]+(\.[0-9]+)*(-[0-9A-Za-z.]+)?$' \
  || die "Version \"$VERSION\" is not a release number, e.g. 1.25.0."

# --- confirm ------------------------------------------------------------------

net_desc=$IP; [ "$IP" = dhcp ] || net_desc="$IP via $GATEWAY"
if [ "$TLS" = proxy ]; then
  tls_desc="reverse proxy on another host -> <container IP>:8080"
  [ -z "$ALLOW_FROM" ] || tls_desc="$tls_desc (only from $ALLOW_FROM)"
else
  tls_desc="Caddy with Let's Encrypt on 80/443"
fi

cat <<EOF

  Syntra $VERSION in a new LXC container

  Container  $CTID ($CT_HOSTNAME), Debian 13, unprivileged
  Resources  $CORES cores, $MEMORY MB RAM, $DISK GB on $STORAGE
  Network    $BRIDGE${VLAN:+ VLAN $VLAN}, $net_desc
  URL        https://$DOMAIN
  TLS        $tls_desc
  Admin      $EMAIL${ORG:+ (organization "$ORG" created now)}

EOF
if [ "$YES" -ne 1 ]; then
  [ -t 0 ] || die "No terminal to confirm on. Pass --yes."
  read -rp "Create it? [y/N] " answer || answer=''
  case "$answer" in y|Y|yes|YES) ;; *) die "Nothing was created." ;; esac
fi

WORK=$(mktemp -d)
LOG=/var/log/syntra-lxc-$CTID.log
: > "$LOG"
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

# Runs a step, output to $LOG; on failure shows the end of it and stops.
step() {
  local title=$1; shift
  msg "$title"
  if ! "$@" >>"$LOG" 2>&1; then
    echo "--- last lines of $LOG:" >&2
    tail -n 25 "$LOG" >&2
    die "$title failed. Container $CTID is left as it is; remove it with: pct stop $CTID; pct destroy $CTID"
  fi
}

# --- release ------------------------------------------------------------------

fetch_release() {
  local base="https://github.com/$REPO/releases/download/v$VERSION"
  curl -fsSL -o "$WORK/syntra-$VERSION.tar.gz" "$base/syntra-$VERSION.tar.gz"
  curl -fsSL -o "$WORK/syntra-$VERSION.tar.gz.sha256" "$base/syntra-$VERSION.tar.gz.sha256"
  (cd "$WORK" && sha256sum -c "syntra-$VERSION.tar.gz.sha256")
  # Named, not piped to grep -q: grep exiting on the first match kills tar
  # with SIGPIPE, and pipefail reports that as a missing file.
  tar -tzf "$WORK/syntra-$VERSION.tar.gz" "syntra-$VERSION/scripts/quickstart.sh" >/dev/null
}
msg "Downloading Syntra $VERSION"
if ! fetch_release >>"$LOG" 2>&1; then
  tail -n 10 "$LOG" >&2
  die "Release $VERSION could not be downloaded and verified, or has no scripts/quickstart.sh (1.20.0 and later do)."
fi

# --- template -----------------------------------------------------------------

ARCH=$(dpkg --print-architecture)
step "Updating the template list" pveam update
TEMPLATE=$(pveam available --section system | awk '{print $2}' \
  | grep -E "^debian-13-standard_.*_${ARCH}\.tar\.zst$" | sort -V | tail -1)
[ -n "$TEMPLATE" ] || die "No Debian 13 template for $ARCH is offered by pveam."
if ! pveam list "$TEMPLATE_STORAGE" | awk '{print $1}' | grep -x "$TEMPLATE_STORAGE:vztmpl/$TEMPLATE" >/dev/null; then
  step "Downloading $TEMPLATE" pveam download "$TEMPLATE_STORAGE" "$TEMPLATE"
fi

# --- container ----------------------------------------------------------------

net="name=eth0,bridge=$BRIDGE,ip=$IP"
[ -z "$GATEWAY" ] || net="$net,gw=$GATEWAY"
[ -z "$VLAN" ] || net="$net,tag=$VLAN"

# SC2054: nesting=1,keyctl=1 is one argument, pct's own comma-separated list.
# shellcheck disable=SC2054
create_args=(
  "$CTID" "$TEMPLATE_STORAGE:vztmpl/$TEMPLATE"
  --hostname "$CT_HOSTNAME"
  --cores "$CORES" --memory "$MEMORY" --swap "$SWAP"
  --rootfs "$STORAGE:$DISK"
  --net0 "$net"
  --unprivileged 1
  --features nesting=1,keyctl=1
  --onboot 1
  --ostype debian
  --timezone host
  --tags syntra
  --description "Syntra $VERSION (Docker Compose in /opt/syntra). Installed by deploy/proxmox/syntra-lxc.sh. Docs: https://github.com/$REPO"
)
[ -z "$DNS" ] || create_args+=(--nameserver "$DNS")
[ -z "$SSH_KEY" ] || create_args+=(--ssh-public-keys "$SSH_KEY")

step "Creating container $CTID" pct create "${create_args[@]}"
step "Starting container $CTID" pct start "$CTID"

wait_for_network() {
  local _
  for _ in $(seq 1 60); do
    if pct exec "$CTID" -- getent hosts deb.debian.org >/dev/null 2>&1; then return 0; fi
    sleep 2
  done
  return 1
}
step "Waiting for the network" wait_for_network

# --- inside the container -----------------------------------------------------

in_ct() { pct exec "$CTID" -- bash -s -- "$@"; }

install_docker() {
  in_ct <<'EOF'
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get -y -q -o Dpkg::Options::=--force-confold full-upgrade
apt-get install -y -q ca-certificates curl openssl locales iptables
sed -i 's/^# *\(en_US.UTF-8 UTF-8\)/\1/' /etc/locale.gen
locale-gen
update-locale LANG=en_US.UTF-8
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
. /etc/os-release
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian $VERSION_CODENAME stable" \
  > /etc/apt/sources.list.d/docker.list
apt-get update -q
apt-get install -y -q docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
systemctl enable --now docker
docker info >/dev/null
docker compose version
EOF
}
step "Installing Docker" install_docker

unpack_release() {
  pct push "$CTID" "$WORK/syntra-$VERSION.tar.gz" "/root/syntra-$VERSION.tar.gz"
  in_ct "$VERSION" <<'EOF'
set -euo pipefail
mkdir -p /opt/syntra
tar -xzf "/root/syntra-$1.tar.gz" --strip-components=1 -C /opt/syntra
rm -f "/root/syntra-$1.tar.gz"
EOF
}
step "Unpacking Syntra $VERSION into /opt/syntra" unpack_release

if [ "$TLS" = proxy ]; then
  # The base compose file binds 127.0.0.1:8080, which a proxy on another host
  # cannot reach. Compose reads docker-compose.override.yml on its own in this
  # mode (quickstart sets COMPOSE_FILE only for Caddy), and !override replaces
  # the base mapping instead of appending a second one for the same port.
  publish_port() {
    in_ct <<'EOF'
set -euo pipefail
cat > /opt/syntra/docker-compose.override.yml <<'YAML'
# Written by deploy/proxmox/syntra-lxc.sh: publish web on every interface so a
# reverse proxy on another host can reach it. Plain HTTP -- see
# /etc/syntra-allow-from to limit who may connect.
services:
  web:
    ports: !override ['8080:8080']
YAML
EOF
  }
  step "Publishing port 8080 for your reverse proxy" publish_port

  # DOCKER-USER is the chain Docker leaves to the operator; it sees traffic to
  # published ports after DNAT, so the match is on the original port. The unit
  # runs Before=docker.service so the rule exists before the port does, and is
  # installed even without --allow-from: an empty file means no restriction,
  # and filling it in later is one restart of the unit.
  allow_from() {
    in_ct "$ALLOW_FROM" <<'EOF'
set -euo pipefail
{
  echo '# Addresses (CIDR) allowed to connect to Syntra on port 8080, one per line.'
  echo '# Empty: anyone. Apply changes with: systemctl restart syntra-allow-from'
  for c in $1; do echo "$c"; done
} > /etc/syntra-allow-from
cat > /usr/local/sbin/syntra-allow-from <<'SH'
#!/bin/sh
# Only the addresses in /etc/syntra-allow-from may connect to Syntra on :8080.
# With none listed, the rule is removed and anyone may.
set -eu
iptables -N DOCKER-USER 2>/dev/null || true
while iptables -D DOCKER-USER -p tcp -m conntrack --ctorigdstport 8080 --ctdir ORIGINAL -j SYNTRA-ALLOW 2>/dev/null; do :; done
iptables -N SYNTRA-ALLOW 2>/dev/null || iptables -F SYNTRA-ALLOW
allowed=$(grep -Ev '^[[:space:]]*(#|$)' /etc/syntra-allow-from 2>/dev/null || true)
[ -n "$allowed" ] || exit 0
for c in $allowed; do
  iptables -A SYNTRA-ALLOW -s "$c" -j RETURN
done
iptables -A SYNTRA-ALLOW -j DROP
iptables -I DOCKER-USER -p tcp -m conntrack --ctorigdstport 8080 --ctdir ORIGINAL -j SYNTRA-ALLOW
SH
chmod 0755 /usr/local/sbin/syntra-allow-from
cat > /etc/systemd/system/syntra-allow-from.service <<'UNIT'
[Unit]
Description=Syntra: limit who may connect to port 8080
Before=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/local/sbin/syntra-allow-from

[Install]
WantedBy=multi-user.target docker.service
UNIT
systemctl daemon-reload
systemctl enable --now syntra-allow-from.service
EOF
  }
  if [ -n "$ALLOW_FROM" ]; then
    step "Limiting port 8080 to $ALLOW_FROM" allow_from
  else
    step "Installing the port 8080 allow-list (empty)" allow_from
  fi
fi

install_updater() {
  in_ct <<'EOF'
set -euo pipefail
cat > /usr/local/sbin/syntra-ct-update <<'SH'
#!/usr/bin/env bash
# Update the Syntra Compose install in /opt/syntra to another release.
#
#   syntra-ct-update            # the latest release
#   syntra-ct-update 1.26.0     # a given release
#   syntra-ct-update --check    # installed and latest versions
#
# Dumps the database first, keeps the previous files in /opt/syntra.prev-<v>,
# and keeps .env and docker-compose.override.yml across the update.
set -euo pipefail
REPO=ssan9876/syntra
DIR=/opt/syntra
DUMPS=/opt/syntra-dumps
die() { echo "syntra-ct-update: $*" >&2; exit 1; }

[ -f "$DIR/RELEASE.json" ] && [ -f "$DIR/.env" ] || die "No Syntra install in $DIR."
current=$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$DIR/RELEASE.json" | head -1)
latest() {
  curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" \
    | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"v\{0,1\}\([^"]*\)".*/\1/p' | head -1
}

if [ "${1:-}" = --check ]; then
  echo "installed: $current"
  echo "latest:    $(latest || echo unknown)"
  exit 0
fi

target=${1:-}
[ -n "$target" ] || target=$(latest) || true
[ -n "$target" ] || die "Latest release could not be read from GitHub. Pass a version, e.g. syntra-ct-update 1.26.0."
target=${target#v}
printf '%s' "$target" | grep -Eq '^[0-9]+(\.[0-9]+)*(-[0-9A-Za-z.]+)?$' || die "Version \"$target\" is not a release number."
[ "$target" != "$current" ] || { echo "Syntra $current is already installed."; exit 0; }
[ "$(printf '%s\n%s\n' "$current" "$target" | sort -V | tail -1)" = "$target" ] \
  || die "Downgrade from $current to $target refused. Restore a dump from $DUMPS instead."

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
base="https://github.com/$REPO/releases/download/v$target"
echo "==> Downloading Syntra $target"
curl -fsSL -o "$tmp/syntra-$target.tar.gz" "$base/syntra-$target.tar.gz" || die "Release $target could not be downloaded."
curl -fsSL -o "$tmp/syntra-$target.tar.gz.sha256" "$base/syntra-$target.tar.gz.sha256" || die "Checksum for $target could not be downloaded."
(cd "$tmp" && sha256sum -c --quiet "syntra-$target.tar.gz.sha256") || die "Checksum of release $target does not match."
mkdir "$tmp/new"
tar -xzf "$tmp/syntra-$target.tar.gz" --strip-components=1 -C "$tmp/new"

cd "$DIR"
umask 077
mkdir -p "$DUMPS" && chmod 0700 "$DUMPS"
dump="$DUMPS/pre-$target-from-$current-$(date +%Y%m%d-%H%M%S).dump"
echo "==> Dumping the database to $dump"
docker compose exec -T postgres pg_dump -U syntra -Fc syntra > "$dump" || die "Database dump failed. Nothing was changed."

echo "==> Replacing the files in $DIR (keeping .env and docker-compose.override.yml)"
rm -rf "/opt/syntra.prev-$current"
cp -a "$DIR" "/opt/syntra.prev-$current"
find "$DIR" -mindepth 1 -maxdepth 1 ! -name .env ! -name docker-compose.override.yml -exec rm -rf {} +
cp -a "$tmp/new/." "$DIR/"
if grep -q '^SYNTRA_VERSION=' .env; then
  sed -i "s/^SYNTRA_VERSION=.*/SYNTRA_VERSION=$target/" .env
else
  echo "SYNTRA_VERSION=$target" >> .env
fi

echo "==> Starting Syntra $target"
docker compose pull --quiet
docker compose up -d --wait --wait-timeout 300 \
  || die "Syntra $target did not become healthy. See: cd $DIR && docker compose logs api. Previous files: /opt/syntra.prev-$current. Database before the update: $dump."
echo "Updated Syntra $current to $target."
SH
chmod 0755 /usr/local/sbin/syntra-ct-update
EOF
}
step "Installing syntra-ct-update" install_updater

# --- quickstart ---------------------------------------------------------------

# Not through step(): its output is the first-run link or, with --org, the one
# time the administrator password is shown, and neither belongs in a log file.
qs_args=(--domain "$DOMAIN" --email "$EMAIL" --version "$VERSION" --project syntra)
[ "$TLS" = caddy ] || qs_args+=(--own-proxy)
[ -z "$SMTP_URL" ] || qs_args+=(--smtp-url "$SMTP_URL")
[ -z "$ORG" ] || qs_args+=(--org "$ORG" --bootstrap)

msg "Starting Syntra (pulls the images; a few minutes)"
echo
if ! pct exec "$CTID" -- bash -c 'cd /opt/syntra && exec scripts/quickstart.sh "$@"' quickstart "${qs_args[@]}" </dev/null; then
  die "Syntra did not start in container $CTID. See: pct exec $CTID -- bash -c 'cd /opt/syntra && docker compose logs api'"
fi

CT_IP=$(pct exec "$CTID" -- hostname -I 2>/dev/null | awk '{print $1}')

echo
msg "Syntra $VERSION is running in container $CTID ($CT_HOSTNAME) at ${CT_IP:-an address from DHCP}."
echo
echo "  URL       https://$DOMAIN"
if [ "$TLS" = proxy ]; then
  echo "  Proxy     point https://$DOMAIN at http://${CT_IP:-<container IP>}:8080 and pass the Host header through."
  if [ -z "$ALLOW_FROM" ]; then
    echo "            Port 8080 is plain HTTP and open to the network. To allow only your proxy:"
    echo "            pct exec $CTID -- sh -c 'echo <proxy IP>/32 >> /etc/syntra-allow-from && systemctl restart syntra-allow-from'"
  fi
else
  echo "  DNS       $DOMAIN must resolve to this container, with ports 80 and 443 forwarded to it."
fi
echo "  Config    /opt/syntra/.env in the container. Back up MASTER_KEY now, off this host:"
echo "            pct exec $CTID -- grep ^MASTER_KEY= /opt/syntra/.env"
echo "  Update    pct exec $CTID -- /usr/local/sbin/syntra-ct-update"
echo "  Log       $LOG"
