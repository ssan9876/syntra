import { loadConfig, type Scheduler } from '@syntra/core';
import { buildApp } from './app.js';
import { startSyncScheduler } from './scheduler.js';

const config = loadConfig(process.env);

// Bound late, and deliberately. The source routes need the scheduler so that
// creating, changing or deleting a source is reflected there and then rather
// than at the next restart -- but the scheduler needs the app's logger, and it
// is allowed to fail to start without keeping the API down. So the app is
// handed a way to ask for the scheduler, and asks only when a source changes.
let scheduler: Scheduler | null = null;
const app = await buildApp(config, { scheduler: () => scheduler });

// Every failure here -- pg-boss unable to start, a bad cron expression on one
// tenant's source, a transient DB error -- is logged inside
// startSyncScheduler, which resolves either way and never rejects. Sync being
// unscheduled must not keep people from signing in.
scheduler = await startSyncScheduler(config, app.log);

await app.listen({ port: config.port, host: '0.0.0.0' });
