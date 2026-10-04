# Provision accounts into Active Directory

Syntra creates, updates, disables and archives AD accounts for people who
have a contract. You set up a target, an account profile and a business rule,
preview the first run, and apply it.

**You need:**

- A domain controller reachable over LDAPS (port 636) or StartTLS, with a
  certificate issued to its hostname. Node does not read the system CA store:
  set `NODE_EXTRA_CA_CERTS` to your CA's PEM if the CA is private.
- An OU for Syntra's accounts, an archive OU outside every directory source's
  search base, and a service account with full control over both:

  ```powershell
  dsacls "OU=Syntra,DC=corp,DC=example,DC=com" /I:T /G "CORP\svc-syntra:GA"
  ```

- Your email domain verified under **Settings → Domains** if the profile writes
  `mail` or `userPrincipalName`.
- People with a contract in force, from an HR feed or **Users → People → Add someone**.

## 1. Create the target

1. **Target systems → New target**.
2. **Name**: `Corp AD`. **Type**: Active Directory.
3. Fill in the connection:

    | Field | Example |
    |---|---|
    | URL | `ldaps://dc01.corp.example.com:636` |
    | Transport | LDAPS |
    | Verify the directory server's TLS certificate | on |
    | Bind DN | `CN=svc-syntra,OU=Syntra,DC=corp,DC=example,DC=com` |
    | Bind password | the service account's password |
    | Base DN | `OU=Users,OU=Syntra,DC=corp,DC=example,DC=com` |
    | Entitlement search base | `OU=Groups,OU=Syntra,DC=corp,DC=example,DC=com` |
    | Archive container | `OU=Leavers,OU=Syntra,DC=corp,DC=example,DC=com` |

4. Leave **Apply scheduled runs automatically** off.
5. **Test connection**. It reports what it can see and which of the four write
   rights it could confirm. Fix anything it reports, then **Create target**.

## 2. Set the account profile

On the target's page, under **Configuration**, open **Account profile**.

1. **Account name template**: the `sAMAccountName`. The default,
   `%person.givenName.first%.%person.familyName%`, gives `jane.doe`. Names are
   cut to 20 characters and a clash gets a number.
2. **Container template**: `%baseDn%` when the base DN is already the users OU.
   **Fallback container**: the same DN.
3. Under **Attributes**, **Add attribute** for each:

    | Attribute | Template |
    |---|---|
    | `givenName` | `%person.givenName%` |
    | `sn` | `%person.familyName%` |
    | `displayName` | `%person.givenName% %person.familyName%` |
    | `mail` | `%person.businessEmail%` |
    | `title` | `%contract.jobTitle%` |

4. Under **Initial password**, pick a **Delivery** and whether to
   **Require a new password at first sign-in**.
5. Under **Preview**, pick a **Person** and check the **Account name** and
   **Container**. Then **Save profile**.

## 3. Add a business rule

Open **Business rules** from the target's page, then **New rule**.

1. **Name**: `IT staff`.
2. **Add condition**: **Department** **is** `IT`.
3. Tick **Create an account for matched people** and **Enabled**.
4. To add AD groups, **Refresh entitlement catalog**, then search under
   **Entitlements granted**.
5. **Preview impact**. Check **People matched**, **Would grant** and
   **Would revoke**, then **Save rule**.

Start with a rule that matches a few people. You can widen it later.

## 4. Preview and apply the first run

1. On the target's page, **Run now**.
2. Open the run under **Runs**. Each proposed action is listed: create, update,
   grant, disable.
3. The first run on a target always shows *First run — always needs
   confirmation.* Read the actions, tick **Apply this run despite the numbers
   above**, then **Apply N actions**. Untick any action you do not want.

New accounts are created disabled, given their password, then enabled. An
account created before the person's start date (see **Pre-hire days**) stays
disabled.

## 5. Check the result

- In AD, the accounts are in the base DN, with Syntra's marker in `info`.
- On a person's page, **Explain access** shows the account and the rule that
  granted it.
- **Provisioning setup** shows the target's checklist with each step verified.

## Next

- Set **Schedule (cron, UTC)** under **Schedule and enforcement**. Turn on
  **Apply scheduled runs automatically** once you trust the previews. Runs
  above the **Safety thresholds** still wait for a person.
- Leavers: set the **Lifecycle timings** (disable, archive, delete).
- Org units as OUs: **Mirror org units as OUs**. See
  [Org units as OUs](../operate.md#org-units-as-ous).
- Real-domain pitfalls (DNS, `.local`, certificates):
  [Active Directory in practice](../operate.md#active-directory-in-practice).
