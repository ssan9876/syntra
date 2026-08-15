import { loadConfig } from '@syntra/core';
import { buildApp } from './app.js';
import { startSyncScheduler } from './scheduler.js';

const config = loadConfig(process.env);
const app = await buildApp(config);

// Scheduling failures (a bad cron expression on one tenant's source, a
// transient DB error) are logged and skipped inside startSyncScheduler --
// they must never keep the API itself from coming up.
await startSyncScheduler(config, app.log);

await app.listen({ port: config.port, host: '0.0.0.0' });
