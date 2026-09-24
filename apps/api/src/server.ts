import { prisma } from '@syntra/db';
import { buildInfo, keyManagementWarnings, loadConfig, masterKeyProviderFor } from '@syntra/core';
import { startTelemetry } from './telemetry.js';
import { buildApp } from './app.js';
import { startSyncScheduler } from './scheduler.js';
import { shutdownHandler } from './shutdown.js';
import { schedulerRecovery } from './scheduler-recovery.js';

const config = loadConfig(process.env);

// Before `buildApp`, because the HTTP hooks decide at registration whether to
// open spans and Prisma instrumentation must precede the first query. A no-op
// -- nothing imported, nothing registered -- unless OTEL_EXPORTER_OTLP_ENDPOINT
// is set. See telemetry.ts.
const telemetry = await startTelemetry(process.env, {
  version: buildInfo().version,
  // The app's logger does not exist yet; this one line goes to stderr.
  log: (message) => process.stderr.write(`${message}\n`),
});

// Bound late, and deliberately. The source routes need the scheduler so that
// creating, changing or deleting a source is reflected there and then rather
// than at the next restart -- but the scheduler needs the app's logger, and it
// is allowed to fail to start without keeping the API down. So the app is
// handed a way to ask for the scheduler, and asks only when a source changes.
const app = await buildApp(config, { scheduler: () => recovery?.current() ?? null });

// Every failure here -- pg-boss unable to start, a bad cron expression on one
// tenant's source, a transient DB error -- is logged inside
// startSyncScheduler, which resolves either way and never rejects. Sync being
// unscheduled must not keep people from signing in.
const recovery = schedulerRecovery(() => startSyncScheduler(config, app.log), app.log);
app.addHook('onClose', async () => { await recovery?.stop(); });
// Last of the close work in registration order, so the spans of the drain
// itself are flushed. Failing to flush must not fail the shutdown.
app.addHook('onClose', async () => {
  await telemetry.shutdown().catch((err: unknown) => app.log.warn({ err }, 'could not flush traces'));
});

// Registered BEFORE `listen`, so a container that is killed seconds after it
// starts still shuts down through this path. Node's default action for either
// signal is to terminate the process outright: no drain, a sync run cut off
// mid-directory, and pg-boss left holding the job it was working.
const shutdown = shutdownHandler({
  app,
  scheduler: () => recovery?.current() ?? null,
  disconnect: () => prisma.$disconnect(),
});
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => void shutdown(signal));
}

await app.listen({ port: config.port, host: '0.0.0.0' });
void recovery.start();

// The master-key provider, said out loud once at startup: which one wraps,
// what is still configured decrypt-only, and whether it answers. Reachability
// is logged rather than fatal, deliberately. A KMS that is down for a minute
// at boot must not turn into an API that refuses to start -- password sign-in
// needs no key at all -- and `/health/ready`'s `key-management` probe is the
// gate that keeps traffic away until it answers. Nothing here logs a key: the
// check wraps and unwraps a random canary and reports only pass or the cause.
app.log.info({ provider: config.keyManagement.provider }, 'master-key provider configured');
for (const warning of keyManagementWarnings(config.keyManagement)) app.log.warn(warning);
void masterKeyProviderFor(config)
  .check()
  .then(
    () => app.log.info({ provider: config.keyManagement.provider }, 'master-key provider answered'),
    (err: unknown) =>
      app.log.error(
        { provider: config.keyManagement.provider, err: err instanceof Error ? err.message : String(err) },
        'master-key provider did not answer; readiness will report key-management until it does',
      ),
  );
