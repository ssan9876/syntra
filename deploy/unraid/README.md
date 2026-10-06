# Syntra on Unraid

There is no Community Applications template for Syntra. A template describes
one container, and Syntra is three that depend on each other: PostgreSQL, the
API and the web front end. The web container proxies to the API by the name
`api`, the API waits for a healthy database, and the database needs
`infra/initdb` mounted on first start to create the `syntra_app` role. The
API image does not contain the built console, so it cannot serve everything
alone either.

Run the Compose stack instead, with the **Compose Manager** plugin.

## Install

1. In **Apps**, install **Docker Compose Manager**. It provides the
   `docker compose` command used below.
2. Open a terminal (**>_** in the Unraid header) and fetch the repository
   into appdata. Unraid has no `git`; the archive is enough. Release 1.19.1
   and earlier do not contain `scripts/quickstart.sh`, so take `main` until a
   later release does:

   ```bash
   mkdir -p /mnt/user/appdata/syntra && cd /mnt/user/appdata/syntra
   wget -qO- https://github.com/ssan9876/syntra/archive/refs/heads/main.tar.gz \
     | tar -xz --strip-components=1
   ```

3. Run the quickstart. Unraid's own web UI already uses ports 80 and 443, so
   use `--own-proxy` (no Caddy) and put your existing reverse proxy in front:

   ```bash
   scripts/quickstart.sh --domain idm.example.com --email you@example.com \
     --smtp-url smtp://mail.example.com:25 --version 1.19.1 --own-proxy --no-start
   ```

   Back up `MASTER_KEY` from `/mnt/user/appdata/syntra/.env` now.

## Reach it from your reverse proxy

`web` publishes `127.0.0.1:8080` only, which a proxy running as a container
(Nginx Proxy Manager, SWAG, Traefik) cannot reach. Join `web` to the proxy's
Docker network instead. Create `/mnt/user/appdata/syntra/docker-compose.override.yml`,
naming the network your proxy uses (`proxynet` here):

```yaml
services:
  web:
    networks: [default, proxynet]

networks:
  proxynet:
    external: true
```

Then start it:

```bash
cd /mnt/user/appdata/syntra && docker compose up -d --wait
```

In the proxy, forward `idm.example.com` to `http://syntra-web-1:8080`, pass
the `Host` header through, and give it a certificate. The container name is
`<directory>-web-1`; `docker compose ps` shows it.

Do not change the `ports:` mapping to `8080:8080` to get round this. That
publishes plain HTTP on every interface beside the proxy.

## Create the first administrator

Follow [the Quickstart](../../docs/install.md#quickstart) from
"Create your organization": if the API log shows a First-run setup link, open
it; otherwise run the bootstrap command from that directory.

## Compose Manager page

To start, stop and update the stack from **Docker → Compose**, add a stack and
set its directory to `/mnt/user/appdata/syntra` under **Advanced**. The
terminal commands above keep working beside it.

## Backups

The database lives in the `syntra-data` Docker volume, inside Unraid's Docker
image or directory, which appdata backup tools do not copy. Take dumps as in
[Operating Syntra](../../docs/operate.md#compose-and-helm-backups). Keep a copy
of `.env` (it holds `MASTER_KEY` and `SESSION_SECRET`) in a password manager,
not on the same share as the dumps: a dump and its key in one place are one
theft away from every stored credential.

## Updates

Change `SYNTRA_VERSION` in `.env`, then:

```bash
cd /mnt/user/appdata/syntra && docker compose pull && docker compose up -d --wait
```

The API applies migrations when it starts. When a release changes
`docker-compose.yml` or `infra/`, fetch its archive first
(`archive/refs/tags/v<version>.tar.gz`, as in step 2, into the same
directory).
