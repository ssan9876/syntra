import { Fragment, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import {
  BREAK_GLASS_SETTINGS,
  SIGN_IN_SETTINGS,
  anyFailing,
  secondFactorHeadline,
  type SignInSecurity,
} from './sign-in-security.js';

/** Names listed in the sentence; the rest are counted. */
const NAMES_SHOWN = 10;

/**
 * The Overview's sign-in checklist: only the checks that fail, each with the
 * place it is fixed. Renders nothing when every check passes.
 */
export function SignInSecurityChecks({ security }: { security: SignInSecurity }) {
  if (!anyFailing(security)) return null;

  const admins = security.adminsWithoutSecondFactor;
  const shown = admins.slice(0, NAMES_SHOWN);
  const more = admins.length - shown.length;

  return (
    <section aria-labelledby="sign-in-security" className="mb-6">
      <h2 id="sign-in-security" className="mb-2 text-md font-semibold text-ink">
        Sign-in security
      </h2>
      <ul className="divide-y divide-border-subtle rounded-panel border border-warning/35">
        {admins.length > 0 && (
          <Check>
            {secondFactorHeadline(admins)}:{' '}
            {shown.map((admin, i) => (
              <Fragment key={admin.userId}>
                {i > 0 && ', '}
                <Link className="link" to={`/admin/users/${admin.userId}`} title={admin.displayName}>
                  {admin.login}
                </Link>
              </Fragment>
            ))}
            {more > 0 && <> and {more} more</>}.
          </Check>
        )}
        {!security.adminMfaRequired && (
          <Check to={SIGN_IN_SETTINGS} action="Sign-in settings">
            The console does not require a second factor.
          </Check>
        )}
        {!security.lockoutEnabled && (
          <Check to={SIGN_IN_SETTINGS} action="Sign-in settings">
            Account lockout is off.
          </Check>
        )}
        {!security.breakGlassDesignated && (
          <Check to={BREAK_GLASS_SETTINGS} action="Break-glass settings">
            No break-glass account designated.
          </Check>
        )}
      </ul>
    </section>
  );
}

function Check({ to, action, children }: { to?: string; action?: string; children: ReactNode }) {
  return (
    <li className="flex items-baseline gap-3 px-4 py-2.5">
      <span aria-hidden="true" className="mt-1.5 size-1.5 shrink-0 self-start rounded-full bg-warning" />
      <span className="min-w-0 flex-1 text-ink">{children}</span>
      {to !== undefined && (
        <Link className="link shrink-0 text-sm" to={to}>
          {action}
        </Link>
      )}
    </li>
  );
}
