import { z } from "zod";

/**
 * The tenant settings the console may change.
 *
 * `slug` and `primaryDomain` are deliberately absent. The first is how a
 * request is routed to this tenant; the second is what a security key's
 * relying party is derived from, so changing it invalidates every credential
 * registered against the old value. Both are operator decisions made against a
 * runbook, not checkboxes — and a field that is not in the schema cannot be
 * written by a body that mentions it.
 */
/**
 * A bare hostname: no scheme, no port, no path. Lower-cased and trimmed BEFORE
 * the pattern runs, because `resolveTenantId` lower-cases the Host header
 * before comparing and a stored `Acme.Example.Com` would simply never match.
 *
 * The pattern accepts an IP address as well as a domain, and that is not an
 * accident: the resolver does a plain string comparison against the hostname,
 * so `192.168.1.10` is a perfectly good name for an instance reached that way.
 * Refusing it would invent a rule the product does not have.
 *
 * One definition for both the primary and the additional list. Two copies of
 * a validation rule are two rules as soon as somebody edits one.
 */
const hostname = z
  .string()
  .max(253)
  .trim()
  .toLowerCase()
  .regex(
    /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/,
    "A hostname only — no scheme, port or path",
  );

/**
 * The platform bounds on a tenant's session lifetimes, in minutes.
 *
 * Here rather than in core because the request schema below and the session
 * service both need them, and core already depends on this package. The
 * migration that added the columns repeats them as CHECK constraints, so a row
 * written without passing through this schema is held to them too.
 *
 * Why each number:
 *
 *   - Admin idle 5–60. Below five, an administrator reading a long audit
 *     page is signed out mid-sentence; above an hour, an unlocked console on
 *     an unattended desk is an administrative session for anybody passing.
 *     Fifteen is the default and what most frameworks for privileged access
 *     ask for.
 *   - Admin absolute 15 minutes – 12 hours. Twelve hours is one long working
 *     day: an elevation should not survive overnight whatever the tenant
 *     says, because elevation is meant to be a fresh authentication and not
 *     a standing state.
 *   - Portal idle 5 minutes – 24 hours, portal absolute 1 hour – 30 days. A
 *     portal session grants no administration, and a tenant whose staff sign
 *     in from managed devices may reasonably want a month; thirty days is the
 *     ceiling because a longer-lived credential is one nobody remembers
 *     issuing.
 *
 * Two relations are enforced as well as the ranges: idle may not exceed
 * absolute within a scope (the idle rule could never fire), and an admin
 * session may not outlive a portal one.
 */
export const SESSION_POLICY_BOUNDS = {
  portalSessionIdleMinutes: { min: 5, max: 1440, default: 60 },
  portalSessionAbsoluteMinutes: { min: 60, max: 43200, default: 720 },
  adminSessionIdleMinutes: { min: 5, max: 60, default: 15 },
  adminSessionAbsoluteMinutes: { min: 15, max: 720, default: 120 },
} as const;

const bounded = (key: keyof typeof SESSION_POLICY_BOUNDS) =>
  z
    .number()
    .int()
    .min(SESSION_POLICY_BOUNDS[key].min)
    .max(SESSION_POLICY_BOUNDS[key].max);

/**
 * `.strict()`. `adminMfaRequired` decides whether the console demands a second
 * factor and `primaryDomain` is the WebAuthn relying party; a misspelling that
 * came back 200 with nothing changed is an operator who believes they hardened
 * an installation and did not.
 */
export const tenantSettingsRequest = z
  .object({
    name: z.string().min(1).max(128).optional(),
    adminMfaRequired: z.boolean().optional(),
    selfEnrolmentEnabled: z.boolean().optional(),
    // The floor the password policy enforces. The lower bound is the product's,
    // not the tenant's: a tenant that could set four would have no policy at all.
    passwordMinLength: z.number().int().min(12).max(128).optional(),
    /**
     * Failed password attempts before an account stops accepting its own
     * password. Zero switches lockout off, which is the default.
     *
     * The lower bound on a lockout that is *on* is 3, not 1: a threshold of
     * one turns a single mistyped password into a support call, and a
     * threshold anybody can set to one is a way to lock a colleague out on
     * purpose.
     */
    lockoutThreshold: z
      .union([z.literal(0), z.number().int().min(3).max(100)])
      .optional(),
    lockoutWindowMinutes: z.number().int().min(1).max(1440).optional(),
    /** Zero means the lock holds until an administrator lifts it. */
    lockoutDurationMinutes: z.number().int().min(0).max(10080).optional(),
    /**
     * Days a password stays good for. Zero never expires it, and is both the
     * default and the recommendation — see the schema comment for why.
     *
     * The lower bound on an expiry that is ON is 30. A tenant that could set
     * one day would be asking every user to choose a new password daily,
     * which is a denial of service dressed as a policy.
     */
    passwordMaxAgeDays: z
      .union([z.literal(0), z.number().int().min(30).max(3650)])
      .optional(),
    /** How many retired passwords may not be chosen again. Zero disables it. */
    passwordHistoryDepth: z.number().int().min(0).max(24).optional(),
    emailOtpEnabled: z.boolean().optional(),
    /**
     * A bare hostname: no scheme, no port, no path. Lower-cased on the way in,
     * because `resolveTenantId` lower-cases the Host header before comparing and
     * a stored `Acme.Example.Com` would simply never match.
     *
     * The pattern accepts an IP address as well as a domain, and that is not an
     * accident: the resolver does a plain string comparison against the
     * hostname, so `192.168.1.10` is a perfectly good primary domain for an
     * instance reached that way. Refusing it would be inventing a rule the
     * product does not have.
     *
     * Nullable clears it, which turns WebAuthn off for the tenant.
     */
    primaryDomain: hostname.nullable().optional(),
    /**
     * How many registered passkeys the caller was told this would break.
     *
     * Checked against the live count rather than trusted: a key enrolled between
     * the warning and the confirmation must not be swept into a decision nobody
     * made about it. Absent means "I have not been warned yet", which is what
     * produces the 409.
     */
    ackPasskeys: z.number().int().min(0).optional(),
    /**
     * Other hostnames this tenant also answers on. Same validation as the
     * primary, sent whole rather than as add/remove: the form owns the list, and
     * a partial update would need a merge rule nobody would remember.
     */
    additionalDomains: z.array(hostname).max(20).optional(),
    /**
     * Session lifetimes, in minutes, within `SESSION_POLICY_BOUNDS`. The
     * cross-field relations (idle within absolute, admin within portal) are
     * checked by the route against the MERGED settings, because a body that
     * mentions only one of a pair must be judged against the other's stored
     * value, which this schema cannot see.
     */
    portalSessionIdleMinutes: bounded('portalSessionIdleMinutes').optional(),
    portalSessionAbsoluteMinutes: bounded('portalSessionAbsoluteMinutes').optional(),
    adminSessionIdleMinutes: bounded('adminSessionIdleMinutes').optional(),
    adminSessionAbsoluteMinutes: bounded('adminSessionAbsoluteMinutes').optional(),
    /**
     * Console elevation requires a WebAuthn credential. Refused by the route
     * unless the caller's own administrative session was established with
     * one — see `docs/configure.md` for the break-glass procedure.
     */
    adminWebauthnRequired: z.boolean().optional(),
  })
  .strict();
export type TenantSettingsRequest = z.infer<typeof tenantSettingsRequest>;

/**
 * Ending sessions across the whole tenant.
 *
 * `scope` narrows it to administrative sessions only — the answer to "an
 * administrator's credentials may have leaked" that does not sign every
 * member of staff out of the portal as well. `keepCurrentSession` spares the
 * one session making the request, so the administrator pressing the button is
 * still in the console to see what it did; it defaults to true because
 * signing yourself out in the middle of incident response is never what the
 * button was pressed for, and somebody who wants it can say so.
 *
 * `reason` is required and lands on the audit event. Every revocation this
 * performs is visible per user already; the reason is what makes the one
 * tenant-wide act that caused them legible afterwards.
 */
export const revokeTenantSessionsRequest = z
  .object({
    scope: z.enum(['all', 'admin']).default('all'),
    keepCurrentSession: z.boolean().default(true),
    reason: z.string().trim().min(10).max(500),
  })
  .strict();
export type RevokeTenantSessionsRequest = z.infer<typeof revokeTenantSessionsRequest>;

/**
 * The tenant's own name, logo and colours on the screens their staff see.
 *
 * `.strict()` like the settings above, and for the same reason one layer over:
 * a misspelled `brandPrimay` that came back 200 leaves an administrator
 * believing they set a colour they did not.
 *
 * Every field is sent whole and nullable — the form owns all four, and null
 * clears one back to Syntra's own. The real constraints (a readable contrast
 * ratio, a logo that is not an SVG and does not fetch from anywhere) live in
 * `brand-service.ts`: they need arithmetic and they need to be enforced
 * wherever a brand is written, not only where this schema is parsed.
 */
export const brandRequest = z
  .object({
    name: z.string().max(64).nullable().optional(),
    logo: z.string().max(400_000).nullable().optional(),
    primary: z.string().max(7).nullable().optional(),
    accent: z.string().max(7).nullable().optional(),
  })
  .strict();
export type BrandRequest = z.infer<typeof brandRequest>;
