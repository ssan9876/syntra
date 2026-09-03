/**
 * A new migration must not sort before the migrations production already
 * applied.
 *
 * The tree now holds many migrations hand-named with dates ahead of the real
 * clock, from `20260825000000` through the newest in `KNOWN_MIGRATIONS`, and
 * the lab has applied all of them. `prisma migrate dev` names what it
 * generates with the REAL timestamp, so a migration written today sorts
 * before those.
 *
 * That matters because the two orders are not the same order:
 *
 *   - `prisma migrate deploy` replays in NAME order on a fresh database, so
 *     the new migration runs BEFORE the six.
 *   - The lab applied the six already, so there it runs AFTER them.
 *   - And `migrate dev` diffs against a shadow database holding the FULL end
 *     state, including their columns -- so the migration it writes may
 *     legitimately reference `OrgUnit.status`, `Tenant.additionalDomains` or
 *     `UpstreamIdp.allowLoginAdoption`.
 *
 * A fresh replay then hits those references before the columns exist. In the
 * good case CI fails loudly; in the bad case a data backfill computes over
 * different state than it did on the lab database and nothing anywhere
 * reports it. `migrationState()` compares name SETS, so the readiness check
 * cannot see it either.
 *
 * The rule: name new migrations above the floor.
 *
 *   npx prisma migrate dev --create-only --name add_a_column
 *   mv prisma/migrations/2026082X.._add_a_column \
 *      prisma/migrations/20260831000000_add_a_column
 *
 * Blocks are allocated per remediation plan in
 * `docs/superpowers/specs/2026-08-24-audit-findings.md` section 11.
 *
 * When the real clock passes the floor this check becomes a no-op and can be
 * deleted along with the hand-dated names.
 */

/**
 * Migrations named at or below this must not be added. It is the highest
 * hand-dated name in the tree.
 */
export const MIGRATION_NAME_FLOOR = '20260928000000';

/**
 * The tree as it stands. Everything here predates the rule and is exempt; the
 * test asserts this list still describes the directory, so it cannot quietly
 * stop covering something.
 */
export const KNOWN_MIGRATIONS: readonly string[] = [
  '20260814232309_init',
  '20260814234738_directory',
  '20260814234940_identity',
  '20260814235217_audit',
  '20260814235439_vault',
  '20260814235641_rbac',
  '20260814235900_rbac_unscoped_unique',
  '20260815000500_auth',
  '20260815010000_directory_sync',
  '20260815020000_mapping_failures',
  '20260815030000_source_directory_fk',
  '20260816000000_access_1',
  '20260817000000_access_2',
  '20260818000000_saml_request_browser_binding',
  '20260818010000_saml_require_signed_authn_requests',
  '20260819000000_oidc_artifact_account_index',
  '20260819010000_federation_request_browser_binding',
  '20260819020000_federation_request_expected_response_to',
  '20260819030000_saml_config_unique_entity_id',
  '20260820000000_provision_targets',
  '20260821000000_provision_run_last_progress',
  '20260822000000_target_paired_source_fk',
  '20260823000000_automate_requests',
  '20260824000000_govern_inventory',
  '20260824020657_directory_writeback',
  '20260825000000_govern_campaigns',
  '20260826000000_govern_exceptions',
  '20260827000000_sync_change_status_index',
  '20260828000000_upstream_login_adoption',
  '20260829000000_tenant_additional_domains',
  '20260830000000_org_unit_status',
  '20260831000000_campaign_revocation_vocabulary',
  '20260903000000_builtin_role_permissions',
  '20260904000000_membership_index_and_one_per_uniques',
  '20260905000000_deployment_manage_backfill',
  '20260906000000_writeback_delete',
  '20260907000000_directory_delete_backfill',
  '20260908000000_login_lockout',
  '20260909000000_password_ageing',
  '20260910000000_webhook_endpoints',
  '20260911000000_application_catalog_key',
  '20260912000000_account_placement',
  '20260913000000_delegated_tasks',
  '20260914000000_application_category',
  '20260915000000_claim_mapping_sets',
  '20260916000000_email_otp',
  '20260917000000_policy_device_country',
  '20260918000000_tenant_branding',
  '20260919000000_wsfed_enabled',
  '20260920000000_parked_request_protocol',
  '20260921000000_org_unit_container',
  '20260922000000_user_duplicate_guards',
  '20260923000000_password_must_change',
  '20260924000000_email_guard_active_only',
  '20260925000000_person_sources',
  '20260926000000_builtin_role_permissions_repair',
  '20260927000000_missing_fk_indexes',
  '20260928000000_tenant_foreign_keys',
  '20260929000000_session_origin',
  '20260930000000_backchannel_logout',
  '20261001000000_logout_delivery_subject',
  '20261002000000_api_tokens',
  '20261003000000_person_list_indexes',
];

/**
 * The migrations that break the rule: at or below the floor, and not already
 * part of the tree.
 */
export function migrationsBelowFloor(names: string[], floor: string): string[] {
  const known = new Set(KNOWN_MIGRATIONS);
  return names
    .filter((name) => !known.has(name))
    .filter((name) => name <= floor)
    .sort();
}
