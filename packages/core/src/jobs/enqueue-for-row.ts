/**
 * Enqueueing the job for a row that has already committed, and saying so
 * when that fails.
 *
 * A manual sync or HR-import run writes its `queued` row first, so the
 * response can name it, and only then asks pg-boss for the job. The order is
 * deliberate (a worker must never read a run id no transaction has written),
 * and it leaves one hole: if the enqueue throws, or pg-boss declines the job,
 * the row stays `queued` for ever. Nothing picks it up, nothing reaps it, and
 * the console follows it and spins with no error anywhere. The provisioning
 * receipts closed the same hole by writing the refusal onto the receipt;
 * this is that rule for the run rows.
 */
export class JobNotQueuedError extends Error {
  constructor(readonly jobName: string, cause?: unknown) {
    super(
      cause instanceof Error
        ? `the job queue refused this run: ${cause.message}`
        : 'the job queue did not accept this run',
    );
    this.name = 'JobNotQueuedError';
    if (cause !== undefined) this.cause = cause;
  }
}

/**
 * Runs `enqueue`; on a throw or a null job id, runs `recordFailure` with a
 * message fit to store on the row, then throws `JobNotQueuedError`.
 *
 * A failure to record the failure is not allowed to replace the original
 * error: the caller needs to know the job was not queued above all else.
 */
export async function enqueueForRow(
  jobName: string,
  enqueue: () => Promise<string | null>,
  recordFailure: (message: string) => Promise<unknown>,
): Promise<string> {
  let failure: JobNotQueuedError;
  try {
    const jobId = await enqueue();
    if (jobId !== null) return jobId;
    failure = new JobNotQueuedError(jobName);
  } catch (cause) {
    failure = new JobNotQueuedError(jobName, cause);
  }
  await recordFailure(failure.message).catch(() => undefined);
  throw failure;
}
