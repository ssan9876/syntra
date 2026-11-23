/**
 * Runs the in-memory example as a service:
 *
 *   CONNECTOR_SECRET=$(openssl rand -base64 32) PORT=8080 npx tsx src/example/serve.ts
 *
 * Plain HTTP on 127.0.0.1. Put a TLS proxy in front of it before a Syntra
 * target points at it: Syntra saves only https:// service URLs.
 */
import { createConnectorServer } from '../server.js';
import { createInMemoryConnector } from './in-memory.js';

const secret = process.env.CONNECTOR_SECRET;
if (!secret) {
  console.error('CONNECTOR_SECRET is not set.');
  process.exit(1);
}
const port = Number(process.env.PORT ?? 8080);
const { connector } = createInMemoryConnector({
  entitlements: [{ id: 'staff', type: 'group', displayName: 'Staff' }],
});
createConnectorServer({ connector, secrets: secret }).listen(port, '127.0.0.1', () => {
  console.log(`${connector.name} listening on http://127.0.0.1:${port}`);
});
