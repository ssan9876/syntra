import { localFileCheckpointSigner, type CheckpointSigner, type Config } from '@syntra/core';

/**
 * The deployment's checkpoint signer, or null when it signs nothing.
 *
 * ONE CONSTRUCTION, TWO CALLERS, and that is the whole point of the file. The
 * scheduler built a signer from `GOVERN_CHECKPOINT_KEY` and the admin route did
 * not — so `POST /govern/integrity/verify` handed `checkpointTrust` a null
 * signer for a checkpoint this deployment had signed itself. `checkpointTrust`
 * correctly answered `unknown_key`, the result was forced to `broken`, a
 * `critical` `audit_chain_broken` finding was raised and mailed, a full genesis
 * walk ran inside the HTTP request, and the recovery branch wrote a new head
 * checkpoint UNSIGNED — so the scheduled run that night refused to seed on it
 * and walked from genesis again.
 *
 * Two call sites that must agree about a security parameter, agreeing by
 * coincidence, is how that happened. They now agree by construction.
 *
 * `== null`, not `=== null`: an absent key must degrade to "this deployment
 * signs nothing" rather than throw during boot.
 */
export function configuredCheckpointSigner(config: Config): CheckpointSigner | null {
  return config.governCheckpointKey == null
    ? null
    : localFileCheckpointSigner(config.governCheckpointKeyId, config.governCheckpointKey);
}
