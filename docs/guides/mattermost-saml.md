# Switch existing Mattermost users to SAML sign-in

Mattermost users who sign in with email and password keep doing so after you
turn on SAML. To move them to SAML, Syntra's Mattermost connector sets each
user's sign-in method (`auth_service`, `auth_data`) on every create and
update. This guide turns that on and applies it to the users you already have.

**You need:**

- A Mattermost target made from the shipped **Mattermost** connector document.
  Setting one up: [Mattermost](../configure.md#mattermost).
- Mattermost Enterprise (SAML is an Enterprise feature), with SAML configured
  against a Syntra SAML application.
- A test server or a few test users first. The connector is tested against an
  in-memory Mattermost, not yet against a real server.

## 1. Sign the whole SAML response

Mattermost rejects a response where only the assertion is signed, with
*We received an invalid signature in the response from the Identity Provider*.

1. **Applications →** your Mattermost application.
2. In the **SAML** panel, under **Request signing**, tick
   **Sign the whole response, not only the assertion**, then
   **Save SAML settings**.

## 2. Decide what `authData` is

Mattermost matches a SAML sign-in to a user by `auth_data`. Look in Mattermost
at **System Console → Authentication → SAML 2.0 → Id Attribute**.

| Id Attribute | Template for `authData` |
|---|---|
| empty | `%person.businessEmail%` |
| set | the template that produces the same value Syntra sends in that attribute (see the application's **Claims**) |

## 3. Check the connector document has the follow-up

The switch is a follow-up request after each create and update. Targets
created before it shipped do not have it.

1. **Target systems →** your Mattermost target.
2. **Edit as JSON** and look under `account` for `followUps`.
3. If it is missing, add it inside `account`:

    ```json
    "followUps": [
      {
        "when": "authService",
        "method": "PUT",
        "path": "/users/{{anchor}}/auth",
        "body": { "auth_service": "{{attr.authService}}", "auth_data": "{{attr.authData}}" }
      }
    ]
    ```

4. **Save**.

The follow-up runs only for accounts that have an `authService` value, so
nothing changes until step 4.

## 4. Map the two attributes

Open **Account profile** from the target's page. Under **Attributes**,
**Add attribute** twice:

| Attribute | Template |
|---|---|
| `authService` | `saml` |
| `authData` | from step 2, usually `%person.businessEmail%` |

Use **Preview** on one person, then **Save profile**.

## 5. Bind the users that already exist

Syntra never takes over an existing Mattermost user on its own. A person whose
user already exists shows up as a conflict.

1. On the target's page, **Accounts in conflict → Find conflicts**. Each
   person is listed with the Mattermost user that matches their business email.
2. **Adopt N accounts**. People with no match, or with two users on the same
   email, are left for you to adopt one by one from their account.

## 6. Run and apply

1. **Run now**, then open the run under **Runs**.
2. Check the proposed actions and apply them. This run switches every managed
   user to SAML, adopted users included.
3. Repeating the switch on a user already on SAML changes nothing.

## 7. Check it

- In Mattermost's System Console, open one switched user and check their
  sign-in method is SAML.
- Sign in as one of them from the Syntra portal. They land in their existing
  account, with their teams and history.

If a sign-in says *An account with that username already exists*, that user
was not switched: check they are adopted and that the last run applied.
