# Syntra demo stack

A Syntra you can let strangers sign in to. It runs the published images with
the demo tenant (`pnpm seed` with `SEED_DEMO=1`: people, applications, two
disabled targets, a half-provisioned hire, a failed target and an overdue
departure), puts the sign-in details on the sign-in page, sends all mail to a
bundled MailDev, and wipes everything back to that state every night.

It is not a production deployment. For that, see the
[Quickstart](../../docs/install.md#quickstart-10-minutes).

## Run it

From a checkout (the stack mounts `infra/initdb` from it):

```bash
git clone https://github.com/ssan9876/syntra.git && cd syntra
SYNTRA_VERSION=1.19.1 deploy/demo/reset.sh
```

The first run writes `deploy/demo/.env` with generated secrets and a
throwaway password, then starts the stack, seeds it and brands it. It takes
about a minute once the images are pulled. The last line says where to sign
in:

```
2026-10-04T04:53:49Z Demo reset finished: http://acme.localhost:8090, admin or jdoe, password demo-56b2fe14.
```

| What | Where |
|---|---|
| Sign-in page | `http://acme.localhost:8090` (Chrome, Edge and Firefox resolve `*.localhost` to this machine) |
| `admin` | Full administrator. Same password as `jdoe`. |
| `jdoe` | Ordinary portal user. |
| Caught mail | MailDev at `http://127.0.0.1:1080` |

The seed is part of the published `syntra-api` image, so nothing has to be
built.

## On a public hostname

Set these before the first run (or edit `deploy/demo/.env` afterwards; the
next reset applies them):

```bash
DEMO_HOST=demo.example.com PUBLIC_URL=https://demo.example.com \
SYNTRA_VERSION=1.19.1 deploy/demo/reset.sh
```

`reset.sh` makes `DEMO_HOST` the demo tenant's primary domain, so SAML, OIDC
and security keys work on it. Put a TLS proxy on the same host in front of
`127.0.0.1:8090`, passing the `Host` header through. With Caddy:

```
demo.example.com {
	reverse_proxy 127.0.0.1:8090
}
```

| Variable in `.env` | Default | Meaning |
|---|---|---|
| `DEMO_HOST` | `acme.localhost` | Hostname the demo answers on. |
| `PUBLIC_URL` | `http://$DEMO_HOST:$DEMO_PORT` | Origin people type. |
| `DEMO_PORT` | `8090` | Loopback port of the web container. |
| `DEMO_PASSWORD` | generated `demo-xxxxxxxx` | Password of `admin` and `jdoe`. 12 to 30 characters; it is shown on the sign-in page. |
| `DEMO_INFO_URL` | `https://github.com/ssan9876/syntra` | `https:` link the sign-in details point to. Empty removes the details from the sign-in page. |
| `SYNTRA_VERSION` | `latest` | Release to run. |
| `MAILDEV_PORT` | `1080` | Loopback port of MailDev's web UI. Read from the environment, not `.env`. |

## Reset nightly

`reset.sh` is the whole reset: `down -v`, `up -d --wait`, seed, brand. Run it
from the host's cron as a user in the `docker` group:

```cron
0 3 * * * /opt/syntra/deploy/demo/reset.sh >> /var/log/syntra-demo-reset.log 2>&1
```

The demo is unavailable for about a minute while it runs. Every session,
change and caught message is gone afterwards; the password stays the same
until you change `DEMO_PASSWORD`.

## The sign-in page

`reset.sh` sets the tenant's brand name to **Demo — resets nightly** and the
sign-in page's help link to *Sign in as admin or jdoe: &lt;password&gt;*,
pointing at `DEMO_INFO_URL`. Anyone who can reach the page has the
administrator password. That is the point, and it is why everything below
matters.

## What not to expose

Publish **only** the web container, through your TLS proxy. Everything else
stays on loopback or the compose network:

- **MailDev's web UI** (`127.0.0.1:1080`). It shows every message the demo
  sends, including password-reset and sign-in links. Reach it over an SSH
  tunnel if you need it.
- **PostgreSQL** and the **API container**. Neither publishes a port; keep it
  that way.
- **Port 8090 itself.** It is plain HTTP; only the proxy should talk to it.

And because every visitor is an administrator:

- **Use throwaway values only.** Never put real names, real directories or a
  real credential into the demo, and never reuse `DEMO_PASSWORD` or anything
  in `deploy/demo/.env` elsewhere.
- **Run it on a host or VM of its own, with no route to a private network.**
  An administrator can add a target or directory source and switch on
  *allow private addresses* for it, which makes the demo connect wherever it
  can reach.
- **Do not set `OUTBOUND_ALLOW_PRIVATE`, a real `SMTP_URL` or
  `MAIL_TRANSPORT=graph`.** Mail goes to MailDev and nowhere else; that is
  what stops the demo being used to send mail.
- **Do not point an application at it for real single sign-on.** The SAML
  signing key is regenerated every night.
