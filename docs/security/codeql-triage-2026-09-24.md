# CodeQL triage — 2026-09-24

This note records the disposition of alerts 1–11 from the first full CodeQL
analysis of `main`. An alert is not considered resolved until the security
workflow analyses the fixing commit.

## Code changes

- **#1, polynomial regular expression:** slug generation now uses a bounded,
  single-pass ASCII normalizer rather than ambiguous repeated regular
  expressions.
- **#9 and #11, client redirect/XSS:** every browser exit now reparses the
  destination and requires a relative same-origin path before assigning it to
  `window.location`.
- **#10, double unescaping:** the SAML test helper decodes ampersands last, so
  an encoded entity cannot be decoded twice.
- **#5, incomplete URL substring check:** the HTTP connector test compares the
  parsed URL origin exactly.
- **#2–#4, incomplete URL substring checks:** protocol allowlist matching now
  expresses exact equality with `some`, avoiding a misleading substring-shaped
  `includes` operation while preserving the required byte-for-byte match.

## False-positive evidence

- **#6:** SHA-256 separates an in-memory Entra token-cache entry by a
  client-secret digest. It neither stores nor verifies a human password.
- **#7:** SHA-256 links append-only audit records. The digest is an integrity
  chain over canonical event data, not a password credential.
- **#8:** SHA-256 verifies a 256-bit, cryptographically random API token. The
  token is not human chosen and has no feasible dictionary, while verification
  occurs on every request. Human passwords elsewhere use Argon2id.

These three alerts may be dismissed as false positives only after the fixing
branch passes CodeQL and the locations remain otherwise unchanged.
