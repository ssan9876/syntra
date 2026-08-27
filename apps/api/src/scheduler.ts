import type { FastifyBaseLogger } from 'fastify';
import { prisma, withTenant } from '@syntra/db';
import {
  applyAutomateSchedules,
  applyGovernSchedules,
  applySourceSchedule,
  applyWebhookSchedule,
  applyTargetSchedule,
  automateSettings,
  createScheduler,
  fileAnchorSink,
  governSnapshotSchedule,
  localMasterKeyProvider,
  mailAnchorSink,
  registerKeyRotationJob,
  registerAutomateJobs,
  registerGovernJobs,
  registerProvisionJobs,
  registerSyncJobs,
  registerWebhookJobs,
  scheduleKeyRotation,
  smtpTransport,
  type Config,
  type Scheduler,
  type Transport,
} from '@syntra/core';
import { configuredCheckpointSigner } from './govern-signer.js';

/**
 * Reconciles the scheduler against every tenant: one signing-key rotation
 * apiece, every directory source, and every provisioning target, with the
 * enabled cron-bearing ones scheduled and the rest unscheduled.
 *
 * This runs once at process startup, not inside a request, so there is no
 * ambient tenant to scope the lookup to. It reads `Tenant` directly -- the
 * one model deliberately left outside row-level security, precisely so
 * startup code like this can enumerate tenants -- and then reads each
 * tenant's sources through `withTenant`, same as any other tenant-scoped
 * read.
 *
 * Nothing in here may reject. The tenant listing itself can fail (a
 * transient database hiccup at boot is enough), and so can the per-tenant
 * source or target lookup, or an individual `schedule()` call (a malformed
 * cron expression). Every one of those is logged and treated as "schedule
 * nothing for this piece" rather than allowed to propagate -- an API that
 * comes up with sync unscheduled is strictly better than one that does not
 * come up at all. The three loops are independent for the same reason: a
 * provisioning read that fails must not cost the tenant its directory sync.
 *
 * Takes the `Scheduler` rather than constructing one, so it can be
 * exercised directly against a fake in tests without standing up pg-boss.
 */
/**
 * How many tenants each subsystem was attempted for, and how many failed.
 *
 * The per-tenant try/catch below is correct and stays: one tenant's bad cron
 * must not cost every other tenant its sync. But it makes a SYSTEMIC failure
 * -- a malformed key, a queue that was never created, a pg-boss upgrade that
 * tightened validation -- look exactly like one tenant's bad data. It is one
 * log line per tenant either way, so on an installation with five hundred
 * tenants a defect arrives as fifteen hundred lines that read like
 * configuration noise and get filtered.
 *
 * The distinction is cheap and worth drawing: if EVERY tenant failed, that is
 * not data, it is code. Exactly that happened here -- three schedule-key
 * builders used colons, which pg-boss refuses, and Automate, Govern and
 * webhook delivery went unscheduled on every tenant for months while the
 * process reported itself healthy.
 */
interface Tally {
  attempted: number;
  failed: number;
}

function tallyOf(tallies: Map<string, Tally>, subsystem: string): Tally {
  const existing = tallies.get(subsystem);
  if (existing) return existing;
  const fresh = { attempted: 0, failed: 0 };
  tallies.set(subsystem, fresh);
  return fresh;
}

export async function scheduleBackgroundWork(
  scheduler: Scheduler,
  logger: FastifyBaseLogger,
): Promise<void> {
  const tallies = new Map<string, Tally>();
  const attempt = (subsystem: string) => {
    tallyOf(tallies, subsystem).attempted += 1;
  };
  const failure = (subsystem: string) => {
    tallyOf(tallies, subsystem).failed += 1;
  };

  let tenants;
  try {
    tenants = await prisma.tenant.findMany();
  } catch (cause) {
    logger.error(
      { err: cause },
      'failed to list tenants for scheduling; no directory sources were scheduled',
    );
    return;
  }

  for (const tenant of tenants) {
    try {
      // Spec section 12: signing keys rotated on a schedule, with overlap.
      // Idempotent -- pg-boss keys the schedule row on (queue, key) and this
      // one names the tenant and the kind -- so re-running it at every boot
      // reconciles rather than accumulates.
      attempt('signing key rotation');
      await scheduleKeyRotation(scheduler, tenant.id);
    } catch (cause) {
      failure('signing key rotation');
      logger.error(
        { err: cause, tenantId: tenant.id },
        'failed to schedule signing key rotation',
      );
    }
  }

  for (const tenant of tenants) {
    let sources;
    try {
      // Every source, not only the eligible ones. pg-boss keeps its schedules
      // in the database, so a source disabled or unscheduled while this
      // process was down still has a schedule row waiting for it; reading the
      // whole list lets `applySourceSchedule` remove those as well as add the
      // rest, which is the difference between reconciling and appending.
      sources = await withTenant(tenant.id, (tx) =>
        tx.directorySource.findMany(),
      );
    } catch (cause) {
      logger.error(
        { err: cause, tenantId: tenant.id },
        'failed to load directory sources for scheduling',
      );
      continue;
    }

    for (const source of sources) {
      try {
        await applySourceSchedule(scheduler, tenant.id, source);
      } catch (cause) {
        logger.error(
          { err: cause, tenantId: tenant.id, sourceId: source.id },
          'failed to schedule directory sync source',
        );
      }
    }
  }

  for (const tenant of tenants) {
    let targets;
    try {
      // Every target, not only the eligible ones -- the same reasoning the
      // source loop above records. pg-boss keeps its schedules in the
      // database, so a target disabled or unscheduled while this process was
      // down still has a schedule row waiting for it; reading the whole list
      // lets `applyTargetSchedule` remove those as well as add the rest, which
      // is the difference between reconciling and appending.
      targets = await withTenant(tenant.id, (tx) =>
        tx.targetSystem.findMany({
          select: { id: true, schedule: true, enabled: true },
        }),
      );
    } catch (cause) {
      logger.error(
        { err: cause, tenantId: tenant.id },
        'failed to load provisioning targets for scheduling',
      );
      continue;
    }

    for (const target of targets) {
      try {
        await applyTargetSchedule(scheduler, tenant.id, target);
      } catch (cause) {
        // Logged, never rethrown. This whole function is "log and do nothing
        // for this piece": an API that comes up with provisioning unscheduled
        // is strictly better than one that does not come up.
        logger.error(
          { err: cause, tenantId: tenant.id, targetSystemId: target.id },
          'failed to schedule provisioning target',
        );
      }
    }
  }

  // LAST, not between the key-rotation and source loops where the plan put it.
  //
  // The loops are independent by design -- "log and do nothing for this piece"
  // -- so their order carries no meaning, but `scheduler.test.ts`'s
  // "still schedules the sources when the target read fails" identifies the
  // transaction to fail BY COUNT ("the sources read is the first transaction
  // of the run and the targets read is the second"). Inserting a transaction
  // ahead of those two makes that test fail the wrong one. Appending here
  // leaves every existing count intact. The coupling is worth knowing about:
  // any future loop added above the source loop breaks that test too.
  for (const tenant of tenants) {
    try {
      attempt('Automate background work');
      const settings = await withTenant(tenant.id, (tx) => automateSettings(tx));
      await applyAutomateSchedules(scheduler, tenant.id, settings.sweepSchedule);
    } catch (cause) {
      failure('Automate background work');
      logger.error(
        { err: cause, tenantId: tenant.id },
        'failed to schedule Automate background work',
      );
    }
  }

  // Webhook delivery. Appended for the same reason as the two loops above --
  // `scheduler.test.ts` identifies the transaction to fail by count -- though
  // this loop opens no transaction at all: the cadence is fixed, so there is
  // no per-tenant setting to read first.
  for (const tenant of tenants) {
    try {
      attempt('webhook delivery');
      await applyWebhookSchedule(scheduler, tenant.id);
    } catch (cause) {
      failure('webhook delivery');
      logger.error(
        { err: cause, tenantId: tenant.id },
        'failed to schedule webhook delivery',
      );
    }
  }

  // AFTER the Automate loop, for the reason the comment above records: the
  // plan put this between the key-rotation and source loops, and
  // `scheduler.test.ts` identifies the transaction to fail BY COUNT. Any loop
  // inserted above the source loop fails the wrong one.
  for (const tenant of tenants) {
    try {
      // Get-or-create through `governSettings`, so a tenant that has never
      // opened the Govern screen is scheduled on the default cadence rather
      // than skipped.
      attempt('Govern background work');
      const schedule = await governSnapshotSchedule(tenant.id);
      await applyGovernSchedules(scheduler, tenant.id, schedule);
    } catch (cause) {
      failure('Govern background work');
      logger.error(
        { err: cause, tenantId: tenant.id },
        'failed to schedule Govern background work',
      );
    }
  }

  // --- did any of that actually take? -------------------------------------
  //
  // Everything above logs its own failures per tenant and carries on, which is
  // the right shape and is also how this whole family of failure hid: a defect
  // that hits every tenant is one log line per tenant, indistinguishable from
  // configuration noise. The two checks below are the aggregate view over
  // those lines, and they run in that order deliberately -- the first names
  // the CAUSE where it can, the second catches everything else.

  // 1. Systemic, not tenant data. If every tenant failed the same subsystem,
  //    no amount of tenant configuration explains it.
  //
  //    The claim is weakened on a single-tenant installation, and deliberately.
  //    With one tenant "every tenant failed" and "this tenant is misconfigured"
  //    are the same observation, and asserting a build defect there would be
  //    stating something this code cannot know. What IS true either way, and
  //    is the part worth waking somebody for, is that the work is not running.
  for (const [subsystem, tally] of tallies) {
    if (tally.attempted === 0 || tally.failed < tally.attempted) continue;
    logger.fatal(
      { subsystem, tenants: tally.attempted },
      tally.attempted > 1
        ? `every one of ${tally.attempted} tenants failed to schedule ` +
          `${subsystem}: that is a defect in this build rather than tenant ` +
          'configuration, and none of that work is running'
        : `${subsystem} could not be scheduled for the only tenant, and that ` +
          'work is not running',
    );
  }

  // 2. Trust nothing: ask pg-boss what it actually holds.
  //
  //    Catches what the tally cannot -- a subsystem that failed for only some
  //    tenants, a schedule silently overwritten by one sharing its key, a
  //    write rolled back under it -- and needs no new call site as subsystems
  //    are added, because the wrapper records the intent.
  try {
    const missing = await scheduler.missingSchedules();
    if (missing.length > 0) {
      // A SAMPLE, not the list. This fires exactly when something systemic is
      // wrong, which on a large installation means every tenant times every
      // subsystem -- five hundred tenants would put several thousand entries
      // in one log line, and a diagnostic that becomes unreadable at the scale
      // it matters most is not a diagnostic. The count carries the size; ten
      // entries carry the shape.
      logger.fatal(
        { missing: missing.slice(0, 10), count: missing.length },
        `${missing.length} scheduled job(s) were requested and pg-boss does ` +
          'not hold them: that work will not run',
      );
    }
  } catch (cause) {
    // Never rethrown, for the reason the whole function records: an API that
    // comes up unable to VERIFY its schedules is still better than one that
    // does not come up.
    logger.error({ err: cause }, 'could not verify the registered schedules');
  }
}

/**
 * Starts the background job scheduler and schedules every enabled,
 * cron-bearing directory source across every tenant. See
 * `scheduleBackgroundWork` for the scheduling behaviour and its failure
 * handling.
 *
 * This never rejects, which is what `server.ts` relies on when it says a
 * scheduling failure must not keep the API from coming up. `scheduler.start()`
 * talks to PostgreSQL and creates pg-boss's queues, and it can fail for
 * reasons that have nothing to do with whether people can sign in; when it
 * does, that is logged and `null` is returned. An API serving sessions with
 * sync unscheduled is strictly better than one that does not boot.
 *
 * Takes its scheduler factory as a parameter for the same reason
 * `scheduleBackgroundWork` takes a `Scheduler`: so the failure path can be
 * exercised without standing up pg-boss.
 */
export async function startSyncScheduler(
  config: Config,
  logger: FastifyBaseLogger,
  create: (databaseUrl: string) => Scheduler = createScheduler,
  options: { transport?: Transport } = {},
): Promise<Scheduler | null> {
  let scheduler: Scheduler;
  try {
    scheduler = create(config.databaseUrl);
    const provider = localMasterKeyProvider(config.masterKey);
    // Built the same way `buildApp` builds it, and a seam for the same reason:
    // so a test can hand in the memory transport rather than putting mail on
    // the wire. Not optional at the registration below -- an unattended
    // `autoApply` provisioning run creates accounts, and one registered with
    // no transport seals every initial password into the vault and sends it to
    // nobody, which is Ruling P12 reintroduced on the one path where nobody is
    // watching.
    const transport = options.transport ?? smtpTransport(config.smtpUrl);
    registerSyncJobs(scheduler, provider);
    // The master key provider is NOT optional: the sender unseals each
    // endpoint's signing secret to sign the body, and one registered without
    // it would post every delivery unsigned, to receivers that would correctly
    // reject all of them. The private-address policy is passed for the same
    // reason it is passed to the routes -- the default is the on-prem one, and
    // a shared installation says otherwise in its configuration.
    registerWebhookJobs(scheduler, provider, {
      allowPrivateAddresses: config.outboundAllowPrivate,
    });
    registerKeyRotationJob(scheduler, provider);
    registerProvisionJobs(scheduler, provider, transport);
    // The transport is NOT optional here. Ruling P16 made this point about
    // Provision's initial passwords: without one, an unattended path produces
    // something and delivers it to nobody. In Automate the whole notification
    // system is that path -- an outbox job registered with no transport sends
    // nothing at all, and the failure is silent.
    registerAutomateJobs(scheduler, transport, { publicUrl: config.publicUrl });
    // EVERY option is passed. `registerGovernJobs(scheduler)` with no second
    // argument compiles, runs, schedules all seven jobs and disables three
    // things at once, saying nothing:
    //
    //  - no `signer`, so `checkpointTrust` is handed `null` on every production
    //    run. The protection is correct, unskippable and mutation-guarded --
    //    and unreachable, because the state it refuses
    //    (`unsigned_while_signer_configured`, exactly the forged checkpoint the
    //    attack inserts) needs a signer to be configured before it can occur.
    //  - no `anchorSink`, so `runAnchorJob` returns `not_configured` forever
    //    and §17's anchoring -- which `AuditAnchor`'s own schema comment calls
    //    the ONLY protection against the operator -- never happens.
    //  - no `publicUrl`, so it defaults to `''` and every critical-finding
    //    alarm carries a relative `/admin/govern/findings/...` link, which in
    //    an email client resolves to nothing.
    //
    // The sibling registrations above pass their dependencies; so does this one.
    registerGovernJobs(scheduler, {
      publicUrl: config.publicUrl,
      transport,
      // Built by `configuredCheckpointSigner`, which the admin route uses too.
      // The two used to construct it separately and one of them forgot.
      signer: configuredCheckpointSigner(config),
      anchorSink:
        config.governAnchorDir != null
          ? fileAnchorSink(config.governAnchorDir)
          : config.governAnchorEmail != null
            ? // The DEPLOYMENT's name, not a tenant's. `registerGovernJobs` runs
              // once for the process and the handler serves every tenant, so a
              // tenant name captured here would be on every other tenant's
              // receipt. A receipt naming the wrong tenant is worse than one
              // naming none; the payload names the tenant and the anchor row
              // records it.
              mailAnchorSink(
                transport,
                config.governAnchorEmail,
                new URL(config.publicUrl).host,
              )
            : null,
    });
    await scheduler.start();
  } catch (cause) {
    logger.error(
      { err: cause },
      'the background job scheduler failed to start; no directory sources were scheduled',
    );
    return null;
  }

  await scheduleBackgroundWork(scheduler, logger);

  return scheduler;
}
