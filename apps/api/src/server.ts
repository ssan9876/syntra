import { loadConfig } from '@syntra/core';
import { buildApp } from './app.js';
import { startSyncScheduler } from './scheduler.js';

const config = loadConfig(process.env);
const app = await buildApp(config);

// Every failure here -- pg-boss unable to start, a bad cron expression on one
// tenant's source, a transient DB error -- is logged inside
// startSyncScheduler, which resolves either way and never rejects. Sync being
// unscheduled must not keep people from signing in.
await startSyncScheduler(config, app.log);

await app.listen({ port: config.port, host: '0.0.0.0' });
