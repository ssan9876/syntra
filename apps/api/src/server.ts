import { prisma } from '@syntra/db';
import { loadConfig, type Scheduler } from '@syntra/core';
import { buildApp } from './app.js';
import { startSyncScheduler } from './scheduler.js';
import { shutdownHandler } from './shutdown.js';

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

// Registered BEFORE `listen`, so a container that is killed seconds after it
// starts still shuts down through this path. Node's default action for either
// signal is to terminate the process outright: no drain, a sync run cut off
// mid-directory, and pg-boss left holding the job it was working.
const shutdown = shutdownHandler({
  app,
  scheduler: () => scheduler,
  disconnect: () => prisma.$disconnect(),
});
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => void shutdown(signal));
}

await app.listen({ port: config.port, host: '0.0.0.0' });
