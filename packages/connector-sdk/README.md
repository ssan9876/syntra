# @syntra/connector-sdk

Build a [Syntra](https://github.com/ssan9876/syntra) target connector as your
own HTTPS service. Syntra calls the service; the service provisions into the
system. None of your code runs inside Syntra.

- `createConnectorServer` / `createConnectorRequestListener`: a `node:http`
  handler that verifies Syntra's request signature, refuses replays and
  foreign protocol versions, validates every request and answer, and maps
  your errors onto Syntra's retry rules.
- `certifyConnectorService`: points at your running service and runs the
  protocol checks and the lifecycle contract every built-in Syntra target
  passes.
- `ConnectorClient`: the calling side, the one Syntra itself uses.
- The protocol as zod schemas, and as JSON Schema in `protocol.schema.json`.
- `@syntra/connector-sdk/example`: a complete connector over an in-memory store.

Protocol, signing, versions and error mapping:
[docs/connector-sdk.md](https://github.com/ssan9876/syntra/blob/main/docs/connector-sdk.md).

Node 22 or later. Apache-2.0.
