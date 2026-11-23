# Roadmap

What is planned, in rough order. Priorities follow what people ask for in
[Discussions](https://github.com/ssan9876/syntra/discussions) and
[issues](https://github.com/ssan9876/syntra/issues): upvote or comment on the
ones you need. Nothing here has a date.

## Now

- A public demo instance, run from [`deploy/demo`](deploy/demo/README.md).
- Translate the rest of the console and portal into Dutch, German, French,
  Spanish and Portuguese. The sign-in screens, the console shell and the
  Targets page are done.

## Next

- Verify more connectors against real systems: Google Workspace, Mattermost and
  Snipe-IT.
- Translate emails, API errors and the SAML, WS-Fed and OIDC pages, with a
  language setting per tenant and person.
- Connector SDK: publish `@syntra/connector-sdk` to npm, and add container
  operations and account deletion for connector services.

## Later

- Updates and restores with `syntra-update` and `syntra-backup` on installs
  with more than one host.

## Changes to this roadmap

Something missing? Start a thread in Discussions → Ideas. Released work moves to
[CHANGELOG.md](CHANGELOG.md).
