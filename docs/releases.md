# Releases

## Versions

Syntra follows [Semantic Versioning](https://semver.org/): `MAJOR.MINOR.PATCH`.

| Bump | When |
|---|---|
| Major | A breaking change to configuration or the API, or a migration that cannot be rolled back. |
| Minor | New features. Existing configuration and API calls keep working. |
| Patch | Fixes only. |

A visible change to how a console screen is operated is at least a minor.

## Cadence

- A minor release roughly once a month.
- Patch releases as needed.
- Security fixes ship as a patch on every supported minor.

## Support window

The latest minor and the one before it get fixes. When 1.20.0 is released,
1.18.x stops getting them. See [SECURITY.md](../SECURITY.md).

## What every release carries

- **Release notes** in the annotated tag message: what changed, for the
  operator deciding whether to take it.
- **Every migration**, by name, in the notes, with whether it rewrites data.
  "No migrations." when there are none.
- **[CHANGELOG.md](../CHANGELOG.md)** updated: the Unreleased section becomes
  the new version.

## How a release is cut

1. Merge to `main` and wait for CI to pass on that commit.
2. In `CHANGELOG.md`, move the Unreleased entries under a new
   `## [x.y.z] - YYYY-MM-DD` heading, add its compare link, and merge that.
3. Tag the green `main` commit with an annotated tag. The tag message is the
   release notes.

   ```bash
   git tag -a v1.20.0 -m "v1.20.0 — …"
   git push origin v1.20.0
   ```

4. The release workflow builds and publishes the release. It refuses a tag
   that is not on `main`, and a tag whose tests fail produces no release.

Details: [operate.md → Cutting a release](operate.md#one-time-setup).
