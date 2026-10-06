import { prisma } from '@syntra/db';
import {
  buildInfo,
  insecureDefaults,
  keyManagementWarnings,
  loadConfig,
  mailSinkWarning,
  latestRestore,
  masterKeyProviderFor,
  waitForRestoreRelease,
} from '@syntra/core';
import { setOperationalLog } from '@syntra/connectors';
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

// Background work (jobs, provisioning and sync runs) logs through the app's
// logger, so its failures reach the same journal and redaction as requests.
const operational = app.log.child({ component: 'background' });
setOperationalLog((level, fields, message) => operational[level](fields, message));

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

// Stops the restore-hold wait and watch on shutdown. Registered before
// listen: Fastify refuses new hooks once it is listening.
const held = new AbortController();
app.addHook('onClose', async () => { held.abort(); });

// A RESTORE WHILE THIS PROCESS RUNS restarts it. Its caches hold the database
// as it was -- an OIDC provider cached before the restore is still "fresh"
// against the restored, LOWER generation counter -- and its scheduler would
// otherwise carry on over a database being replaced. The backup agent writes
// a hold before it touches anything and waits 20 seconds; this checks every
// 5. The supervisor (Compose, systemd, Kubernetes) starts it again, held.
//
// The NEWEST hold row, released or not: a restore resumed within seconds of
// finishing is still a restore this process's caches did not see.
let knownRestore: string | null | undefined = await latestRestore().then(
  (hold) => hold?.id ?? null,
  () => undefined,
);
const restoreWatch = setInterval(() => {
  latestRestore().then(
    (hold) => {
      const id = hold?.id ?? null;
      if (knownRestore !== undefined && hold && id !== knownRestore) {
        clearInterval(restoreWatch);
        app.log.warn({ backupName: hold.backupName }, `restarting: restore of ${hold.backupName} detected`);
        void shutdown('restore').finally(() => process.exit(0));
        return;
      }
      knownRestore = id;
    },
    // Unreachable mid-restore, while the agent has the role locked out.
    () => undefined,
  );
}, 5_000);
restoreWatch.unref();
held.signal.addEventListener('abort', () => clearInterval(restoreWatch));

await app.listen({ port: config.port, host: '0.0.0.0' });

// After a restore, background work waits until an administrator resumes it.
// Sign-in and the console run meanwhile, so the restored data can be checked.
void waitForRestoreRelease({
  signal: held.signal,
  onHeld: (hold, err) => {
    if (hold) {
      app.log.warn(
        { backupName: hold.backupName, restoredAt: hold.restoredAt.toISOString() },
        `background work held: restored from ${hold.backupName}, not resumed`,
      );
    } else {
      app.log.error(
        { err: err instanceof Error ? err.message : String(err) },
        'background work held: restore hold could not be read',
      );
    }
  },
}).then((released) => {
  if (released) void recovery.start();
});

// The master-key provider, said out loud once at startup: which one wraps,
// what is still configured decrypt-only, and whether it answers. Reachability
// is logged rather than fatal, deliberately. A KMS that is down for a minute
// at boot must not turn into an API that refuses to start -- password sign-in
// needs no key at all -- and `/health/ready`'s `key-management` probe is the
// gate that keeps traffic away until it answers. Nothing here logs a key: the
// check wraps and unwraps a random canary and reports only pass or the cause.
app.log.info({ provider: config.keyManagement.provider }, 'master-key provider configured');
for (const warning of keyManagementWarnings(config.keyManagement)) app.log.warn(warning);
// MailDev and its peers accept every message and deliver none, so nothing
// else in the log would ever say that mail is going nowhere.
const mailSink = mailSinkWarning(config);
if (mailSink) app.log.warn({ smtpServer: mailSink.server }, `mail not delivered: ${mailSink.message}`);
// The same text the Overview shows as an incident. Warnings, never a refusal
// to start: a lab on plain HTTP is a supported way to try Syntra.
for (const insecure of insecureDefaults(config)) {
  app.log.warn({ variable: insecure.variable }, `insecure configuration: ${insecure.message}`);
}

// FIRST-RUN SETUP. Only when the database has no tenant at all. The link is
// written to standard output directly, not through the logger: the logger
// scrubs URL queries and long tokens from every line, which is right for
// everything else and would leave this line without the one thing it is for.
void app.firstRunSetup.open().then(
  (link) => {
    if (!link) return;
    const url = new URL('/setup', config.publicUrl);
    url.searchParams.set('token', link.token);
    app.log.warn({ expiresAt: link.expiresAt.toISOString() }, 'first-run setup open: no tenant exists');
    process.stdout.write(`First-run setup: open ${url.toString()} within 1 hour. The link works once.\n`);
  },
  (err: unknown) =>
    app.log.error({ err: err instanceof Error ? err.message : String(err) }, 'first-run setup check failed'),
);
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
