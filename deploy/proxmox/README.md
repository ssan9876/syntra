# Syntra on Proxmox VE

`syntra-lxc.sh` creates an LXC container on a Proxmox VE host and installs
Syntra in it: an unprivileged Debian 13 container with Docker, a release
tarball checked against its published SHA-256, and
[`scripts/quickstart.sh`](../../scripts/quickstart.sh) run inside it. What you
get is the ordinary Compose install from
[Install → Quickstart](../../docs/install.md#quickstart), in `/opt/syntra`.

## Install

On the Proxmox host, as root:

```bash
curl -fsSL https://raw.githubusercontent.com/ssan9876/syntra/main/deploy/proxmox/syntra-lxc.sh -o syntra-lxc.sh
less syntra-lxc.sh   # read it first
bash syntra-lxc.sh --domain idm.example.com --email you@example.com
```

It shows what it will create and asks before creating it. Without `--domain`
or `--email` it asks for them. `--help` lists every option.

| Option | Default |
|---|---|
| `--ctid` | the next free ID |
| `--hostname` | `syntra` |
| `--cores` / `--memory` / `--disk` | 2 / 4096 MB / 20 GB |
| `--storage` | `var_container_storage` from community-scripts' `default.vars`, else `local-lvm` |
| `--template-storage` | `var_template_storage` from `default.vars`, else `local` |
| `--bridge` / `--vlan` | `vmbr0` / none |
| `--ip` | `dhcp`; static is `--ip 192.168.1.50/24 --gateway 192.168.1.1` |
| `--version` | the latest release (1.20.0 or later) |
| `--tls` | `proxy` |
| `--org NAME` | none: open the first-run link instead |

Non-interactive, with a static address and the organization created up front:

```bash
bash syntra-lxc.sh --yes --ctid 120 --ip 192.168.1.50/24 --gateway 192.168.1.1 \
  --domain idm.example.com --email you@example.com --org "Example Ltd" \
  --allow-from 192.168.1.10/32
```

With `--org`, the administrator password is printed once, at the end. Without
it, the script prints the first-run link from the API log. The link is valid
for one hour (`docker compose logs api | grep "First-run setup"` in
`/opt/syntra` shows it again).

**Back up `MASTER_KEY` straight away**, somewhere other than this host:

```bash
pct exec <ctid> -- grep ^MASTER_KEY= /opt/syntra/.env
```

## TLS

**`--tls proxy` (default).** `web` listens on `<container IP>:8080`, plain
HTTP, for a reverse proxy on another host: nginx, Nginx Proxy Manager,
Traefik, a Cloudflare tunnel. The base compose file binds `127.0.0.1:8080`
only; the script writes a `docker-compose.override.yml` that publishes it on
every interface.

Point the proxy at `http://<container IP>:8080`, pass the `Host` header
through, and send `X-Forwarded-For`. The compose file already trusts
forwarded headers from private ranges (`TRUST_PROXY`). See
[TLS](../../docs/install.md#tls) for what else the proxy must do.

Port 8080 carries session cookies and SAML assertions in the clear, so limit
it to the proxy. `--allow-from` does this at install time. Afterwards, edit
`/etc/syntra-allow-from` in the container, one CIDR per line, and run
`systemctl restart syntra-allow-from`. An empty file means anyone may connect.

**`--tls caddy`.** Caddy in the container gets a Let's Encrypt certificate for
`--domain`. The name must resolve to the container, with ports 80 and 443
forwarded to it from the internet.

## Update

```bash
pct exec <ctid> -- /usr/local/sbin/syntra-ct-update --check    # installed and latest
pct exec <ctid> -- /usr/local/sbin/syntra-ct-update            # to the latest release
pct exec <ctid> -- /usr/local/sbin/syntra-ct-update 1.26.0     # to a given release
```

It verifies the new release's checksum and dumps the database to
`/opt/syntra-dumps/`. It keeps the previous files in `/opt/syntra.prev-<version>`
and `.env` and `docker-compose.override.yml` as they are. Then it pulls the new
images and waits for the stack to report healthy. It refuses to downgrade. To
go back, restore a dump: see [Backups](../../docs/operate.md#backups).

## What is where

| In the container | |
|---|---|
| `/opt/syntra` | the release, `.env` (mode 600), `docker-compose.override.yml` |
| `/opt/syntra-dumps` | database dumps taken before each update |
| `/usr/local/sbin/syntra-ct-update` | the updater |
| `/etc/syntra-allow-from`, `syntra-allow-from.service` | the port 8080 allow-list (`--tls proxy`) |
| Docker volumes `syntra_syntra-data`, `syntra_syntra-backups` | the database and the console's restore points |

On the host, `/var/log/syntra-lxc-<ctid>.log` holds the install output. It
does not contain secrets: the quickstart step, which prints the first-run link
or password, is not logged.
