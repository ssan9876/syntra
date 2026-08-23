# Syntra with Active Directory — install and setup

A complete build: Syntra served over HTTPS, a Windows Active Directory domain
behind it, synchronisation in both directions, and SAML single sign-on to a
third-party application.

Written as it was actually built, including what went wrong. The failures are
the useful part — each one below cost real time and none of them is obvious
from the error message alone.

**Part one, [Install](#part-one--install)**, builds the machines and gets
software running. **Part two, [Setup](#part-two--setup)**, configures Syntra
to do something.

---

## Conventions

Addresses and names are from the reference build; substitute your own.

| Role | Reference value |
|---|---|
| Proxmox host | `192.168.88.4` |
| Syntra | `192.168.88.20:3000`, published at `syntra.example.com` |
| Domain controller | `192.168.88.21` |
| Tunnel connector | `192.168.88.200` |
| AD forest | `example.local` (NetBIOS `EXAMPLE`), DC named `AD-DC` |
| Service account | `svc-syntra` |

**No password in this document is real.** Passwords appear as
`<SYNTRA_ADMIN_PW>`, `<DOMAIN_ADMIN_PW>`, `<SVC_SYNTRA_PW>` and
`<DSRM_PW>`. Generate them, and keep them in a password manager rather than
in a repository — this file is version-controlled and a credential committed
once stays in the history.

---

# Part one — Install

## 1.1 The domain controller

### Unattended install

A Windows Server 2022 evaluation ISO plus an answer ISO carrying
`autounattend.xml` and `bootstrap.ps1` builds the whole thing without a click:
Windows installs, takes a static address, installs AD DS and promotes itself
to a new forest.

```bash
# BIOS/MBR with a SATA disk and an e1000 NIC deliberately: Server 2022 has
# in-box drivers for both, so Setup needs no driver injection and cannot
# stall on a disk it cannot see.
qm create 102 --name ad-dc --ostype win10 --bios seabios --machine pc \
  --cores 4 --memory 6144 --balloon 0 \
  --sata0 local-lvm:60 --net0 e1000,bridge=vmbr0 \
  --ide2 local:iso/SERVER_2022_EVAL_x64.iso,media=cdrom \
  --ide0 local:iso/lab-answer.iso,media=cdrom \
  --ide1 local:iso/virtio-win.iso,media=cdrom \
  --boot order=ide2\;sata0 --agent 1
qm start 102
```

25–40 minutes including the promotion reboot.

**Watch open ports, not disk usage.** Thin-provisioned disk percentage is a
poor progress signal and misled us twice. Ports are unambiguous: 445 and 135
mean Windows is up; 389, 88 and 53 mean the forest exists.

```bash
for p in 389 636 53 88 445; do
  timeout 2 bash -c "echo >/dev/tcp/192.168.88.21/$p" 2>/dev/null \
    && echo "  $p open" || echo "  $p closed"
done
```

### If the domain name is wrong, rebuild — never rename

`Install-ADDSForest` bakes the forest root in, and renaming an AD forest
afterwards is genuinely unpleasant. A lab DC with nothing in it is not worth
it. Edit, rebuild the ISO, wipe, restart:

```bash
mount -o loop,ro /var/lib/vz/template/iso/lab-answer.iso /mnt/ans
cp -r /mnt/ans/. /root/answer-src/ && umount /mnt/ans
sed -i 's/olddomain\.test/example.local/g; s/OLDNETBIOS/EXAMPLE/g' \
  /root/answer-src/bootstrap.ps1
genisoimage -J -R -V ANSWER -o /var/lib/vz/template/iso/lab-answer.iso \
  /root/answer-src
```

**Verify the ISO before wiping the disk** — `grep -ci olddomain` on the
mounted image should be zero. Rebuilding twice because one reference was
missed costs another half hour.

**Reclaim the orphaned disk.** `qm set 102 --delete sata0` *detaches* rather
than destroys: the old disk becomes `unused0` and keeps consuming the thin
pool. `qm set 102 --delete unused0` actually frees it.

### Remote management

If the guest agent fails to install, **WinRM (5985) is open by default on
Server 2022** and is enough to drive everything else without a rebuild.

```python
# ps.py — pipe PowerShell in on stdin
import sys, winrm
s = winrm.Session("http://192.168.88.21:5985/wsman",
                  auth=(r"EXAMPLE\Administrator", "<DOMAIN_ADMIN_PW>"),
                  transport="ntlm")
r = s.run_ps(sys.stdin.read())
print(r.std_out.decode(errors="replace"))
```

`apt-get install python3-winrm` provides the library. Basic auth over HTTP is
only defensible on a private bridge; on anything else use HTTPS (5986).

### Moving the DC's address

Changing the address over WinRM kills the session mid-command, so run it as a
scheduled task and let it finish detached. **Remove stale A records before
re-registering**, or the zone advertises the DC at two addresses and clients
pick whichever answers first:

```powershell
foreach ($z in @("example.local","_msdcs.example.local")) {
  Get-DnsServerResourceRecord -ZoneName $z -RRType A |
    Where-Object { $_.RecordData.IPv4Address.IPAddressToString -eq $old } |
    ForEach-Object { Remove-DnsServerResourceRecord -ZoneName $z -InputObject $_ -Force }
}
ipconfig /registerdns
Restart-Service Netlogon, DNS -Force
```

### LDAPS is mandatory, so the DC needs a certificate

Syntra's target configuration deliberately has no plaintext option:

> `plain` is absent: writes to a target require an encrypted transport
> unconditionally, and a target that could be configured to write in the clear
> is a target that eventually does.

An enterprise CA is the standard way to get a DC certificate, and it is what a
real AD estate already has:

```powershell
Install-WindowsFeature AD-Certificate -IncludeManagementTools
Install-AdcsCertificationAuthority -CAType EnterpriseRootCA `
  -CACommonName "example-CA" -KeyLength 2048 -HashAlgorithmName SHA256 `
  -ValidityPeriod Years -ValidityPeriodUnits 10 -Force
certutil -pulse; gpupdate /force   # do not wait for auto-enrolment
Restart-Service NTDS -Force        # LDAPS binds once a certificate exists
```

**Installing a CA changes the forest** and is not casually reversible. Decide
deliberately.

## 1.2 Directory structure

Read and write are separate subtrees on purpose, so a provisioning mistake
cannot overwrite the directory being synced from.

```
DC=example,DC=local
├── OU=Company            ← Syntra READS
│   ├── OU=IT
│   ├── OU=Finance
│   └── OU=Nursing
└── OU=Syntra             ← Syntra WRITES
    ├── OU=Users
    └── OU=Archive
```

The service account is **not** a Domain Admin. Full control over `OU=Syntra`
only; read access to the rest is what any authenticated account already has,
which is all the upward sync needs.

```powershell
dsacls "OU=Syntra,DC=example,DC=local" /I:T /G "EXAMPLE\svc-syntra:GA"
(Get-ADUser svc-syntra -Properties MemberOf).MemberOf   # expect nothing
```

## 1.3 Syntra

### Build and serve

One process serves the API, the console and the portal. `WEB_ROOT` is what
makes that true; `pnpm dev` is a development server and does not belong in
front of anything.

```bash
pnpm install && pnpm db:generate && pnpm db:migrate
pnpm build                       # vite build -> apps/web/dist
```

```ini
# .env
PUBLIC_URL=https://syntra.example.com
WEB_ROOT=/root/syntra/apps/web/dist
TRUST_PROXY=192.168.88.200
NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/example-ca.crt
```

Two systemd units, and the dependency between them is the point. Both are in
[`systemd/`](systemd).

- **`syntra-infra.service`** owns the containers. The compose file is a
  *development* file with no restart policies, so after a reboot nothing came
  back and the API started against a database that was not there.
- **`syntra.service`** waits for PostgreSQL to accept connections, not merely
  for Docker to exist. The API tolerates a missing database by starting anyway
  and logging *"no directory sources were scheduled"* — a quiet failure, which
  is exactly why the unit has to catch it.

Prove it with a reboot rather than assuming, and check the boot log is clean:

```bash
systemctl reboot
journalctl -u syntra -b | grep -ciE "scheduler failed|ECONNREFUSED"   # expect 0
```

### Publishing it

Point a Cloudflare tunnel (or any reverse proxy) at `192.168.88.20:3000` over
**plain HTTP**, with the **Host header left untouched**. Two mistakes produce
an identical `Request failed` at the connector: an `https://` service URL when
the origin speaks HTTP, and a stale origin address.

## 1.4 Four traps

**`TRUST_PROXY` must name the connector.** Without it every request carries
the connector's address: policy source-address conditions match everyone or
nobody, and every per-IP rate limit collapses into one bucket shared with the
whole internet.

**The tenant must claim the hostname it is reached on.** `syntra.example.com`
matches neither `primaryDomain` (`example.com`, exactly) nor the additional
domains, and the slug fallback takes the **leftmost label** — `syntra`, which
is not the slug. It 404s as an unknown tenant and looks like a tunnel fault.
Make the public name the *primary* domain: it is what the SAML entity ID, the
SSO endpoints and the WebAuthn relying party are built from.

**`.local` does not resolve on Linux.** `systemd-resolved` treats `*.local` as
multicast DNS and refuses to forward it to a unicast server, so `dig @dc`
resolves the domain and `getent hosts` does not. This looks like a broken DC
and is the resolver following the RFC. Windows clients are unaffected.

```ini
# /etc/systemd/resolved.conf.d/10-ad-local.conf
[Resolve]
MulticastDNS=no
LLMNR=no
```

**Node ignores the system CA store.** `update-ca-certificates` satisfies
`openssl` and `curl` and does nothing for Node, which carries its own bundled
Mozilla list. LDAPS fails with *"unable to verify the first certificate"*
while `openssl s_client` against the same host verifies cleanly.
`NODE_EXTRA_CA_CERTS` is the only fix short of disabling verification, which
is not a trade worth making for a directory bind.

![Certificate failure](images/03-source-cert-failure.jpg)

---

# Part two — Setup

## 2.1 Reading from Active Directory

**Directory sources → Connect a directory.**

![Empty sources](images/01-sources-empty.jpg)

| Field | Value |
|---|---|
| Server URL | `ldaps://ad-dc.example.local:636` |
| Transport | LDAPS |
| Verify certificate | **on** |
| Bind DN | `CN=svc-syntra,OU=Syntra,DC=example,DC=local` |
| User / group / OU search base | `OU=Company,DC=example,DC=local` |

Use the DC's **hostname, not its IP** — the certificate is issued to
`AD-DC.example.local` and verification fails against an address.

Press **Active Directory** under attribute mappings for `sAMAccountName`,
`mail` and `displayName` with an AD-shaped user filter.

![Source form](images/02-source-form.jpg)

**Test connection** reports what it can actually see, which is the quickest
way to find a wrong search base:

![Connected](images/04-source-connected.jpg)

**Run now** produces a plan and writes nothing:

![Sync preview](images/05-sync-preview.jpg)

Untick to leave a change proposed; skip to record it as never to be applied.
**Apply** commits:

![Sync applied](images/06-sync-applied.jpg)

Accounts and hierarchy arrive marked read-only and source-owned — the console
offers no edit or deactivate control for them, because the next run would
overwrite it:

![Org units](images/07-org-units-synced.jpg)
![Users](images/08-users-synced.jpg)

## 2.2 Writing to Active Directory

**Target systems → Connect a target.** Same credentials, different subtree:

| Field | Value |
|---|---|
| URL | `ldaps://ad-dc.example.local:636` |
| Base DN | `OU=Users,OU=Syntra,DC=example,DC=local` |
| Entitlement search base | `OU=Syntra,DC=example,DC=local` |
| Archive container | `OU=Archive,OU=Syntra,DC=example,DC=local` |
| Enforcement | Additive |

The connection test enumerates the rights the bind account holds and is honest
about the ones it cannot prove:

![Target rights](images/09-target-rights.jpg)

> A right it could not confirm is not a right it has.

### Account profile

Use `%baseDn%` for the container when the base DN already ends in `OU=Users` —
the default template would produce `OU=Users,OU=Users,…`. The fallback
container is **required**: Provision does not create organisational units in
somebody else's domain.

![Account profile](images/10-account-profile.jpg)

The live preview resolves templates against a real person before saving:

![Preview](images/11-profile-preview.jpg)

### Business rule

Provisioning acts on **people with contracts**, not on synced accounts. A rule
names who gets an account, and **Preview impact** says exactly who it hits:

![Rule impact](images/12-rule-impact.jpg)

### The run

The first run is blocked on purpose and says why:

![Blocked run](images/13-run-blocked.jpg)

> this target has never had a run applied, so the first run is confirmed by a
> person whatever the thresholds say
>
> the create axis has no denominator on this run: the target holds no accounts
> at all, so the 20% threshold cannot be applied

Acknowledge and apply:

![Applied run](images/14-run-applied.jpg)

Verify in the directory rather than trusting the screen:

```powershell
Get-ADUser -SearchBase "OU=Users,OU=Syntra,DC=example,DC=local" `
  -Filter * -Properties displayName
```

## 2.3 SAML single sign-on

**There is no SAML configuration screen in the console yet.** The API supports
it and the identity provider works; registration is currently an API call.

```bash
# The application must be type "saml" — a bookmark is refused
curl -b "$J" -X PUT -H 'Content-Type: application/json' \
  -d '{"type":"saml"}' "$B/api/admin/applications/$APP"

curl -b "$J" -X PUT -H 'Content-Type: application/json' -d '{
  "spEntityId":    "https://app.example.com",
  "acsUrls":       ["https://app.example.com/saml/acs"],
  "defaultAcsUrl": "https://app.example.com/saml/acs",
  "nameIdFormat":  "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress",
  "wantAuthnRequestsSigned": false,
  "sloUrl":        "https://app.example.com/saml/sls",
  "allowIdpInitiated": true
}' "$B/api/admin/applications/$APP/saml"
```

`wantAuthnRequestsSigned` defaults to **true** and is refused without a
certificate to check against — deliberately. Set it `false` only for a service
provider that does not sign, and turn it back on once you have registered
their signing certificate.

Give the service provider:

| Field | Value |
|---|---|
| IdP metadata URL | `https://syntra.example.com/saml/metadata/<application-id>` |
| IdP entity ID | `https://syntra.example.com/saml/idp` |
| SSO URL | `https://syntra.example.com/saml/sso` |
| SLO URL | `https://syntra.example.com/saml/slo` |
| NameID | email address |

SSO is served **only on the tenant's primary domain**. Reaching Syntra by IP
returns a 421 naming the correct host. That is the product refusing correctly —
SAML entity IDs are bound to the hostname — not a misconfiguration.

### Attribute mapping

An assertion carries no attributes until you say what to put in it. Registering
the service provider is not enough: the `AttributeStatement` comes out empty,
the service provider finds nothing to match on, and the sign-in fails with
nothing written to either side's log. Map the claims explicitly.

```bash
curl -b "$J" -X POST -H 'Content-Type: application/json' -d '{
  "protocol": "saml", "claimName": "username",
  "sourceKind": "user", "sourceField": "login",
  "nameFormat": "urn:oasis:names:tc:SAML:2.0:attrname-format:basic"
}' "$B/api/admin/applications/$APP/claims"
```

Three claims cover most service providers — `username` from `login`, `email`
from `email`, `displayname` from `displayName`. Read them back at
`GET /api/admin/applications/<id>/claims`.

**The claim names are the service provider's, not ours.** Snipe-IT reads an
attribute literally called `username`; another application will want
`uid`, or the full `http://schemas.xmlsoap.org/...` URI. Take the names from
the service provider's own documentation and mirror them here.

### The account has to exist on both sides, under the same name

Most service providers match an assertion against a user they already hold, and
they match on the **username** — not the email address in the NameID. If Syntra
knows somebody as `a.brennan` and the application knows them as `abrennan`,
sign-in fails, and it fails silently: the assertion validates, no user matches,
the browser lands back on the login page.

Both names come from the directory, so fix it there. Set the AD account's
`sAMAccountName` to whatever the application already uses, re-run the sync, and
the two agree permanently.

### Testing it without a browser

An assertion can be posted straight at the service provider's ACS URL:

```bash
curl -b "$J" "$B/saml/start/$APP" -o /tmp/sp.html     # IdP-initiated form
R=$(grep -oE 'name="SAMLResponse" value="[^"]*"' /tmp/sp.html | sed 's/.*value="//; s/"$//')
curl -c /tmp/j -b /tmp/j -X POST --data-urlencode "SAMLResponse=$R" https://app.example.com/saml/acs
curl -c /tmp/j -b /tmp/j https://app.example.com/login    # completes the sign-in
curl -c /tmp/j -b /tmp/j https://app.example.com/         # should render signed in
```

The third request is not optional and it is where the test usually goes wrong.
Several service providers — Snipe-IT among them — do not sign anybody in at the
ACS; they validate the assertion, stash it in the session, and redirect to
their own login route, which is what actually establishes the session. A test
that stops at the ACS sees a 302 back to `/login` and reads it as a rejection
when the handshake is working.

Two other things that make a clean test look like a failure: `curl -L` will
re-POST into a route that only accepts GET and return 405, and assertions are
single-use, so each attempt needs a freshly generated one.

## 2.4 Email

Syntra sends mail for password resets, factor enrolment, approval requests and
campaign invitations. `SMTP_URL` points at a development mail sink by default,
which accepts everything and delivers nothing.

```ini
SMTP_URL=smtps://user:password@mail.example.com:465
```

Two things to get right, and they are separate:

- **The address people are mailed at** comes from the directory. If accounts
  sync from AD with `mail` set to `user@example.local`, that is where mail is
  addressed — an internal-only domain that a real mail server will not accept.
  Fix the `mail` attribute in AD and re-run the sync; the source owns that
  field and rewrites it every run, so changing it in Syntra will not hold.
- **Links inside those mails** come from `PUBLIC_URL`, which must be the
  externally reachable name.

---

## Rebuilding from nothing

1. Create the DC VM; wait for 389/88/53.
2. Install AD CS, force enrolment, confirm 636.
3. Export the CA root, install it on the Syntra host, set `NODE_EXTRA_CA_CERTS`.
4. Create the OU structure and the service account; delegate `OU=Syntra` only.
5. Deploy Syntra: build, both units, `WEB_ROOT`, `PUBLIC_URL`, `TRUST_PROXY`.
6. Point the tunnel at port 3000 over plain HTTP, host header untouched.
7. Make the public hostname the tenant's primary domain.
8. Source → test → run → apply.
9. Target → profile → rule → run → confirm → apply.
10. Register the service provider; hand over the metadata URL.
