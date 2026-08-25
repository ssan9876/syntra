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

## 1.4 Five traps

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

**A public resolver listed behind the DC breaks internal names at random.**
Not "when the DC is down" — at random. Listing two nameservers looks like a
primary and a fallback, and `systemd-resolved` does not read them that way: it
treats every server on a link as equivalent for every name, picks one as its
Current DNS Server and switches between them freely.

```
       DNS Servers: 192.168.88.21 1.1.1.1
Current DNS Server: 1.1.1.1              <- and every ssander.local lookup NXDOMAINs
```

Whenever it settles on the public one, LDAP and Kerberos lookups fail with
nothing wrong at either end and nothing in any log to say why. The DC forwards
what it cannot answer, so name it alone:

```yaml
      nameservers:
        addresses: [192.168.88.21]        # the DC, and only the DC
        search: [ssander.local]
```

Losing the public resolver loses nothing real. If the DC is down, a host whose
whole job is talking to that DC has no work to do either.

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

## 2.5 Leavers: archive, then delete

Two systems share this, and the split is the point.

```
Provision  --archive_account-->  OU=Deactivated  --30 days-->  scheduled task deletes
                                       |
                                       +-- object has left the sync search base
                                           => next sync proposes deactivate_user
```

**Syntra archives. The domain deletes.** Syntra has no delete operation of any
kind — `write` in the AD connector rejects one before it binds, with a message
that says so rather than answering "not found":

```
"delete_account" is not an operation this connector implements;
there is no delete of any kind
```

That is deliberate and it stays. An unrecoverable write, driven by a timer,
issued by a service that holds bind credentials for every tenant's directory,
is a bad trade — one wrong contract import empties a directory. On the domain
controller the blast radius is one domain, the operator is the domain's own
scheduler, and the AD Recycle Bin covers a mistake for the deleted-object
lifetime.

### The archive OU must be a SIBLING of the sync search base

This is the whole mechanism, and getting it wrong is silent.

| | |
|---|---|
| Sync search base | `OU=Company,DC=example,DC=local` |
| Archive container | `OU=Deactivated,DC=example,DC=local` |

Provision moves the object to the archive; the object thereby leaves the sync's
search base; the next run reads it as absent and proposes `deactivate_user`
(`packages/core/src/sync/diff.ts:151`). You review that like any other change
and apply it.

Nest the archive **inside** `OU=Company` and none of it happens. The sync keeps
seeing the account, keeps it active, and you have an archive that archives
nothing. Nothing errors.

This is also the answer to "why can't I deactivate a synced user in the
console?" The control is withheld because a matched-but-inactive record is read
as *the account came back*, and the next run proposes reactivating it
(`diff.ts:104`) — the button would appear to work and quietly undo itself. Move
the object out of the search base and the deactivation arrives through the
source, which is the only place it holds.

### Install

```powershell
# On the domain controller, as a domain administrator.
.\install-reap.ps1 -Domain example.local
```

That creates `OU=Deactivated` at the domain root, protects it from accidental
deletion, enables the AD Recycle Bin, installs `syntra-reap.ps1` into
`C:\ProgramData\Syntra`, and registers a daily task as SYSTEM.

**Enabling the Recycle Bin cannot be undone**, and it is the reason this design
puts deletion here rather than in Syntra. Without it, a wrong sweep is
unrecoverable. It needs a 2008 R2 forest functional level or better.

**The archive has to be somewhere the provisioning account can write.** The
domain root is the natural home — one archive serving every population — but
Provision moves objects into it with `modifyDN`, and a service account
delegated over a single subtree cannot write to the root:

```
CREATED refused: 00000005: SecErr: DSID-03152DE3, problem 4003 (INSUFF_ACCESS_RIGHTS)
```

That refusal is correct and worth keeping. Either delegate the archive OU to
the provisioning account, or put the archive inside the subtree the account
already holds — it only has to sit outside the *sync* search base, not at the
root:

```powershell
.\install-reap.ps1 -Domain example.local `
    -ArchiveOu "OU=Deactivated,OU=Syntra,DC=example,DC=local"
```

**It installs in dry run.** The task logs what it would delete and deletes
nothing. Read `C:\ProgramData\Syntra\reap.log` for a few days, confirm the OU
and the dates are what you expect, then arm it:

```powershell
.\install-reap.ps1 -Domain example.local -Apply
```

Then point Syntra at the same OU and turn on the ladder's archive rung:

```bash
# archiveContainer must match the OU exactly. Config replaces rather than
# merges, so send the whole bag; omit bindPassword and the stored secret is
# left alone.
curl -b "$J" -X PATCH -H 'Content-Type: application/json' \
  -d '{"archiveAfterDays": 0}' "$B/api/admin/targets/$TARGET"
```

`archiveAfterDays: 0` archives on the departure date, so the 30 days of
retention are served entirely in the OU. Split it differently if you prefer —
`archiveAfterDays: 7` with `-RetentionDays 23` gives the same total.

### Watching a leaver, end to end

Provision acts on **Persons with contracts**, not on synced users, and anchors
the ladder on the departure date. Import people and the whole chain becomes
testable in a few minutes.

```csv
externalId,givenName,familyName,businessEmail,sequence,isPrimary,startDate,endDate,jobTitle,department
P-1001,Rowan,Ellis,rowan.ellis@example.com,1,true,2024-03-04,,Registered Nurse,Care
P-1002,Nadia,Okonjo,nadia.okonjo@example.com,1,true,2025-01-13,,Healthcare Assistant,Care
P-1003,Tomas,Brandt,tomas.brandt@example.com,1,true,2023-06-01,,Registered Nurse,Care
P-1004,Priya,Raman,priya.raman@example.com,1,true,2025-09-01,2027-09-30,Senior Nurse,Care
P-1005,Ivo,Marek,ivo.marek@example.com,1,true,2024-11-18,,Management Accountant,Finance
```

```bash
curl -b "$J" -X POST -H 'Content-Type: application/json' \
  -d "$(python -c "import json,io;print(json.dumps({'csv':io.open('people.csv').read()}))")" \
  "$B/api/admin/persons/import"
# {"created":5,"updated":0,"errors":[]}
```

Ivo is the control. With one business rule of `contract.department == Care`,
the plan proposes **four** creates, not five — which is the rule being read
rather than assumed.

```bash
curl -b "$J" -X POST -H 'Content-Type: application/json' -d '{}' \
  "$B/api/admin/targets/$TARGET/runs"          # 202 with a jobId; the run is async
curl -b "$J" "$B/api/admin/targets/$TARGET/runs"          # newest first
curl -b "$J" "$B/api/admin/targets/$TARGET/runs/$RUN"
```

Then end somebody's contract — re-import the one row with an `endDate` in the
past — and run it again. The ladder produces the two steps in order:

```
disable_account   [applied] disabled
archive_account   [applied] archived
```

Read the directory afterwards and the object has moved:

```
live         rowan.ellis / nadia.okonjo / priya.raman     enabled
deactivated  tomas.brandt                                 DISABLED
```

The next sweep stamps `syntra-reap-after=<departure + 30 days>` and, on the day
that arrives, deletes the object.

#### Expect the guard to stop you, twice

Both refusals below are the guard working. Neither is a misconfiguration.

**"the target returned no accounts at all, and a run has been applied against
it before"** — this one is **not confirmable**, deliberately: an empty target
and an unreachable one look identical from Syntra, and the safe reading is the
second. It fires on a target whose accounts were deleted by hand after a
successful run. `TargetSystem.lastAppliedRunAt` is the input; clearing it says
"this target has never had a successful apply", which is what is actually true
once nothing that run created survives. Clear only that — the run rows and
their audit events are the record, and are not the guard's business.

**"would disable 1 of 4 active accounts (25.0%), above the 10% threshold"** —
this one **is** confirmable. In a lab of four people one leaver is 25% of the
population, and every departure will trip it. Send `confirm: true`:

```bash
curl -b "$J" -X POST -H 'Content-Type: application/json' \
  -d '{"confirm":true}' "$B/api/admin/targets/$TARGET/runs/$RUN/apply"
```

#### Proving the delete without waiting a month

Put a throwaway in the archive OU with a stamp already in the past, and another
that is **enabled**, then run the sweep once. One pass covers all three paths:

```
[STAMP]  tomas.brandt: due 2026-09-23
[DELETE] zz.reaptest (…) -- due 2026-07-01
[HOLD]   zz.reaplive: enabled -- not a leaver, skipping
=== APPLY done: stamped=1 deleted=1 held=1 waiting=0 ===
```

The overdue disabled account is destroyed, the overdue **enabled** one is held,
and the real leaver — having no stamp yet — is given the full retention period
rather than destroyed on the run that first noticed it.

Then restore the deleted one, which is the recoverability the whole placement
argument rests on:

```powershell
$d = Get-ADObject -Filter 'SamAccountName -eq "zz.reaptest"' -IncludeDeletedObjects
Restore-ADObject -Identity $d.DistinguishedName
```

It comes back in its original OU with its attributes intact.

### The clock

The retention period is measured from a stamp the sweep writes into
`adminDescription`:

```
syntra-reap-after=2026-09-22
```

`adminDescription` and not `info`, because Syntra writes its provenance note to
`info` and a sweep that overwrote it would destroy the marker identifying
accounts Syntra created. The stamp is one line among whatever else the
attribute holds, so a note written by hand survives a sweep and a sweep
survives a note written by hand.

On first sight of an unstamped account the due date is `whenChanged` plus the
retention period — `modifyDN` sets `whenChanged`, so for a freshly archived
object that is the archive time. It is only an estimate, since any later
modification bumps it, and one rule makes that safe:

**No account is ever deleted on the run that first stamps it.** However old
`whenChanged` claims to be, the first sight floors the due date at tomorrow. A
wrong OU costs a log entry rather than the accounts in it.

A stamp that will not parse is treated as a clock that is *corrupted*, not one
that is *absent*: the account is held forever rather than silently re-stamped,
because re-stamping would restart the retention period on every run and the
account would live indefinitely with nobody noticing.

### What the sweep refuses to do

| | |
|---|---|
| An **enabled** account in the archive | Held. Somebody re-enabled it or moved it by hand; it is live, and this does not delete live accounts. |
| **Protected from accidental deletion** | Held. That flag is an explicit human "not this one". |
| More than `-MaxDeletesPerRun` due at once | Deletes up to the cap, logs the rest. A bad import upstream arrives here as a flood; the cap turns it into a small loss and a loud log. |
| Anything at all without `-Apply` | Logs, changes nothing. |

### Testing the clock

`syntra-reap.Tests.ps1` covers the date arithmetic — the part that decides
whether an account is destroyed — and runs on any machine with no directory:

```powershell
powershell -NoProfile -File .\syntra-reap.Tests.ps1
```

It lifts the functions out of `syntra-reap.ps1` by parsing it rather than
copying them, so a test cannot pass against logic that is no longer shipped.

### Two populations, one archive

The lab keeps synced people and provisioned accounts in different subtrees:

| | |
|---|---|
| `OU=Company` | People read **from** AD by the directory source. |
| `OU=Users,OU=Syntra` | Accounts written **to** AD by Provision. |

They do not overlap, and a domain-root `OU=Deactivated` sits outside both, so
one archive and one sweep serve them together. Provision moves its own accounts
there when the ladder fires; a leaver in `OU=Company` gets there by being moved,
which is also what tells the sync they have gone.

Note that Provision acts on **Persons with contracts**, not on synced users, and
anchors the ladder on the departure date. Until people are imported with
contracts there is nothing for it to archive — ending a contract is the button.

## 2.6 Self-service

Everything under `/security`, reachable by any signed-in user from the header.
No administrator, no ticket.

| | |
|---|---|
| Password | Change it, given the current one |
| Authenticator app | Enrol a TOTP code |
| Security keys and passkeys | Register a WebAuthn credential |
| Recovery codes | Issue a fresh set |

### Giving a joiner their first password

A person who arrives through Directory sync or Provision has a login and no
password, and neither self-service route reaches them: the change form below
needs the password they do not have, and the reset form needs a mailbox that
may not exist yet. Syntra verifies against its own hash and never binds to the
directory, so the domain password Provision generated does nothing here.

Users → the row → **Password link** mints a link and shows it to copy. It lasts
24 hours, works once, and minting a second one kills the first — there is one
live link per user, and a self-service reset the person requests themselves
supersedes an admin-minted link just the same.

It is offered for synced accounts as well as local ones, because a
directory-owned user still signs in against Syntra's own hash. The one case it
refuses is a user whose `passwordSource` is `upstream`: that password lives at
the federated provider, and the console says so rather than minting a link that
could not work.

The link is a bearer credential — whoever holds it can set that password until
it expires or is spent. Every issuance is audited as
`auth.password_setup_issued`, naming the administrator who minted it, so a link
that is later misused is attributable.

### Changing a password

```
POST /api/auth/password
{ "currentPassword": "…", "newPassword": "…" }
→ 200 { "ok": true, "otherSessionsRevoked": 2 }
```

**A change is not a reset, and does not borrow its machinery.** A reset starts
from an unauthenticated stranger holding a mailbox link, so it spends a token,
demands a second factor and revokes everything. A change starts from somebody
already signed in who re-types the password they hold — a different and
stronger claim — and it should not cost them a trip through their inbox.

The current password is re-entered rather than trusted from the session, the
same way `/elevate` treats elevation as a fresh authentication rather than a
flag flip. The endpoint is rate-limited exactly as `/login` is: it takes a
password and answers whether it was right, which is the same oracle a sign-in
is, and holding a session already does not change that.

No second factor is demanded. The request carries two independent things
already — a live session and the current password — and an attacker with a
stolen session still cannot pass the second. Requiring a factor as well would
strand a user who has enrolled one and is on a device that cannot present it.

### Which sessions survive

**Every other session is signed out. The one making the change is not.**

That session is the evidence the whole request rests on; revoking it would sign
somebody out of the tab they are looking at, at the moment they are told it
worked. The others go, because evicting whoever else has the password is the
entire reason for changing it — leaving them alive makes the change cosmetic.
Refresh tokens go too: one outliving a change hands back exactly the access the
change existed to end.

The response says how many, so the confirmation can be specific rather than
reassuring in the abstract.

### The refusals

| Response | Meaning |
|---|---|
| `403 wrong-password` | The current password does not match |
| `422 weak-password` | Below `passwordMinLength`, over 1024, or predictable |
| `422 password-unchanged` | The new password is the one already set |
| `409 password-held-upstream` | `passwordSource` is not `local` |
| `409 no-password-set` | The account signs in without a password at all |

`password-unchanged` exists because re-typing the same password reads as
success and changes nothing — the worst possible outcome for somebody changing
it *because* it leaked. It is compared against the stored hash, not the string.

`password-held-upstream` carries `passwordSourceHint` in the detail, so the
user is told **which** system owns their password rather than being left to
guess. Writing a local hash for an upstream account would create a second,
divergent password that authenticates nowhere they expect.

### What a synced account can and cannot do here

An account synced from Active Directory holds a Syntra password only if one was
set for it — the directory owns the identity, not the credential. By default,
changing that Syntra password **does not change the password in AD**, and vice
versa: the user ends up with two, and only finds out which is which at the
Windows login prompt.

Turn on **write-back** and they become one. See §2.7.

---

## 2.7 Write-back: changing Active Directory from Syntra

Everything above this point is one-way. Syntra reads the directory and never
writes to it, which is the safe default and the wrong one for two jobs people
actually need: changing a password once rather than twice, and deactivating a
leaver from the console.

### Turn it on

**Directory sources → (your source) → Write-back.** Three switches, all off
until somebody turns them on, and off for every source that existed before the
feature did:

| Switch | What it allows | What the bind needs |
|---|---|---|
| Allow Syntra to write to this directory | the master switch; nothing below works without it | — |
| Deactivating a user disables their account here | the Deactivate button on a directory-managed user | write `userAccountControl` on accounts in scope |
| Self-service password change writes through | the portal changes the domain password | **nothing extra** |

That last row is the important one. Syntra changes a password by binding **as
the user**, with the password they just typed, and performing the standard LDAP
change on their own object. The service account is not involved and gains
nothing.

The alternative would be to bind as `svc-syntra` and reset the password
administratively, which needs the **Reset Password** right across the user OU.
Do not grant that. A bind credential that can reset any password in the OU is a
full account-takeover primitive sitting in a vault, and everything it buys you
here is already available without it.

### Delegating the disable right

`svc-syntra` needs to write `userAccountControl` on the accounts it manages.

**On the OU the directory SOURCE reads — not the one the target writes to.**
They are different OUs here and the mistake is silent: everything saves,
everything looks configured, and the first refusal arrives on the day somebody
leaves. In this lab the source's `userSearchBase` is `OU=Company` and Provision
creates accounts under `OU=Users,OU=Syntra`; deactivating a *synced* user
touches the first. Delegate on both if you want either to work.

```powershell
Import-Module ActiveDirectory
$sid      = (Get-ADUser -Identity "svc-syntra").SID
$uacGuid  = [Guid]"bf967a68-0de6-11d0-a285-00aa003049e2"   # userAccountControl
$userGuid = [Guid]"bf967aba-0de6-11d0-a285-00aa003049e2"   # the user class

foreach ($ouDn in @(
  "OU=Company,DC=ssander,DC=local",   # what the directory source reads
  "OU=Syntra,DC=ssander,DC=local"     # what Provision writes to
)) {
  $ou  = [ADSI]"LDAP://$ouDn"
  $ace = New-Object System.DirectoryServices.ActiveDirectoryAccessRule(
    $sid, "WriteProperty", "Allow", $uacGuid, "Descendents", $userGuid)
  $ou.ObjectSecurity.AddAccessRule($ace)
  $ou.CommitChanges()
}
```

Scoped to one attribute, on one object class, in named OUs. `GenericWrite` on
the OU also works and is shorter to type; it also lets the same credential
rewrite everybody's group memberships, which is not what it is for.

To check it took:

```powershell
(Get-Acl "AD:OU=Company,DC=ssander,DC=local").Access |
  Where-Object { $_.IdentityReference -like "*svc-syntra*" }
```

### What deactivating actually does

Pressing **Deactivate** on a directory-managed user, in order:

1. sets the disable bit in AD — immediately, not after the grace period,
2. marks the user inactive in Syntra and revokes every session and refresh
   token,
3. stamps an administrative departure on the linked person, which puts them on
   the ordinary leaver ladder: entitlements revoked, archived into
   `OU=Deactivated,OU=Syntra`, and reaped by the scheduled task after 30 days.

The directory is written **first**. If AD refuses, nothing changes anywhere and
the console says why — rather than Syntra believing something the domain never
agreed to.

`disableGraceDays` is deliberately bypassed here. It exists to delay the
disable after a *scheduled* departure, the contract ending on the 31st that
nobody wants killed at 00:01. A human clicking Deactivate means now: the two
reasons anyone clicks it are "they left today" and "this account is
compromised". Everything after the disable still runs on the configured timers.

**Reactivate** reverses all three. Inside the 30-day window nothing has been
deleted, and the sweep independently refuses to delete an enabled account.

### The disabled-in-AD gap this closed

Before write-back existed there was a hole worth knowing about, because the
instinct it punished is the correct one.

Directory Sync read every account AD returned and never looked at
`userAccountControl`. So an account **disabled in AD** — the first line of
every offboarding runbook — stayed `active` in Syntra indefinitely. Syntra
refuses a login only when the status is not active, so that check never fired:
the leaver kept their portal login and their SSO into everything Syntra fronts,
including Snipe-IT. Nothing was logged, because nothing was wrong. AD reported a
disabled account, Syntra reported an active user, and both were telling the
truth about themselves.

Sync now reads the bit. Disable somebody in AD, run a sync, and Syntra
deactivates them with the reason `Disabled in directory source`. To see it:

```bash
# On the DC
Disable-ADAccount -Identity someone

# Then run a sync from Directory sources -> Run now, and check:
#   the user shows Inactive, reason "Disabled in directory source, run <id>"
#   their portal login is refused
#   their Snipe-IT SSO no longer works
```

It also stops sync fighting the console: the reactivate branch will not
resurrect an account the source still reports disabled, which is exactly why
the Deactivate button could not exist before.

### When a password change is refused

With password write-back on, **the domain's policy applies, not Syntra's**, and
it is stricter in ways people do not expect:

- **Minimum password age.** AD's default is one day. A user whose password was
  set or changed yesterday cannot change it again today, and the portal says
  the directory refused it. This is not a bug and it is the evidence the change
  is being done properly — an administrative reset would bypass it.
- **Password history.** 24 by default. Changing back to a recent password is
  refused by the DC; Syntra has no idea what the last 24 were and does not need
  to.
- **Complexity and length.** The domain's, checked after Syntra's own.

The portal checks the tenant policy first, so an obviously weak password is
refused locally without spending an attempt against the domain's lockout
counter. A wrong *current* password does count against lockout, and should: a
portal that let someone grind a domain password without ever tripping lockout
would be a hole, not a convenience.

If the DC is unreachable the change is refused with "nothing was changed" —
never quietly applied locally, which would recreate the two-password problem
this exists to end.

---

## 2.8 Updating Syntra from the console

Settings → **Updates** shows the running version, what is available, and a
button. Getting there needs three one-time steps, and one thing to understand
first.

### Why this is not an ordinary update button

Syntra is what you sign in with. An update that breaks authentication takes
away the console you would use to undo it, and the SSO it fronts goes with it —
in this lab, Snipe-IT. Three things follow, and they are the whole design:

- **The updater is not part of Syntra.** It runs as its own transient systemd
  unit. A child process of the API would be killed by the restart the update
  itself causes, between the migration and the symlink swap — the least
  recoverable state this system has.
- **The rollback needs nobody.** If the new version does not come up, the
  updater puts the old one back — code *and* database — on its own. "Sign in
  and click rollback" is exactly what a broken sign-in prevents.
- **What it checks can fail.** `/health` is a constant: it returns 200 with the
  database unreachable and the migration half-applied. `/health/ready` is the
  gate, and it tests the database, the migration state, whether `MASTER_KEY`
  still unseals the vault, and whether the console bundle exists.

### One-time: convert to the release layout

An install that runs from one directory has nothing to roll back *to* — the old
files are the ones an update overwrites.

```bash
cd /root/syntra
./ops/syntra-install --dry-run     # read what it will do
./ops/syntra-install
```

It copies `/root/syntra` to `/opt/syntra/releases/dev`, moves `.env` into
`/opt/syntra/shared/`, points `current` at the release, and rewrites the
systemd unit. **The old tree is left exactly where it is**, so recovery is
restoring `syntra.service.pre-release-layout` and restarting.

### One-time: a token

A fine-grained GitHub token, **read-only**, scoped to this repository only, with
`Contents: Read`. Nothing else. In `/opt/syntra/shared/.env`:

```
RELEASE_REPO=ssan9876/syntra
RELEASE_TOKEN=github_pat_…
RELEASE_ROOT=/opt/syntra
```

Not a git credential, and not `git clone`: the host never gains the ability to
read source history, only to download release assets. Revoke it from GitHub
without touching the box.

### One-time: cut a release

Nothing is updatable until something has been released — until then the page
says so and points at `deploy.sh`, because a working tree has no version to
update from.

```bash
git tag -a v1.0.0 -m "First release."
git push origin v1.0.0
```

The tag message becomes the notes an operator reads before deciding. CI runs
first: **a tag whose tests fail produces no release.**

### What pressing Update does

1. Downloads the release and checks its SHA-256.
2. Unpacks it beside the running one and installs its dependencies.
3. **Dumps the database — and stops if that fails.** Migrating without a
   backup is the one step here that cannot be undone.
4. Applies migrations, swaps the `current` symlink, restarts.
5. Polls `/health/ready` for 90 seconds.
6. If it does not go green: puts the old release back, restores the dump,
   restarts, and records why.

Signing in stops working for about a minute. Sessions already open survive.

### Doing it by hand

```bash
/opt/syntra/bin/syntra-update --check        # what is running, what is available
/opt/syntra/bin/syntra-update --adopt 1.5.0  # once, by hand: take a converted `dev` install to its first release
/opt/syntra/bin/syntra-update 1.5.0          # update
/opt/syntra/bin/syntra-update --rollback     # go back deliberately
cat /opt/syntra/var/update.status            # what it is doing right now
```

### Things worth knowing before you need them

- **`deploy.sh` still works** and is still the right tool for iterating. It
  writes into `current`, which leaves the tree no longer matching its release.
  The updater only checks whether `RELEASE.json` is present — it refuses a
  working tree that has none, but a `deploy.sh` push made on top of an
  existing release still has one, so the updater does **not** notice that push
  and would overwrite it silently. Detecting that would take hashing the
  release manifest, which is not implemented.
- **A rollback does not undo what happened during the update.** The dump is
  from just before the migration; a login or a sync run in the minute since is
  not in it.
- **Three releases and three dumps are kept.** The one you are running is never
  pruned, because deleting it is how a rollback becomes impossible at the
  moment it is needed.
- **`/health` and `/health/ready` are different questions.** Keep the tunnel
  and any external monitoring pointed at `/health`: a liveness probe that fails
  when Postgres blips restarts a healthy API.

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
