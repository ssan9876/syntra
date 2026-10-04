/**
 * The shape of `GET /api/admin/tenant/sign-in-security`, and the sentences
 * the Overview's checklist builds from it.
 */
export interface AdminWithoutSecondFactor {
  userId: string;
  login: string;
  displayName: string;
  owner: boolean;
}

export interface SignInSecurity {
  adminsWithoutSecondFactor: AdminWithoutSecondFactor[];
  adminMfaRequired: boolean;
  lockoutEnabled: boolean;
  breakGlassDesignated: boolean;
}

export const SIGN_IN_SECURITY_URL = '/api/admin/tenant/sign-in-security';
export const SIGN_IN_SETTINGS = '/admin/settings?tab=sign-in';
export const BREAK_GLASS_SETTINGS = '/admin/settings?tab=break-glass';

/**
 * "3 Owners have no second factor", "1 administrator has no second factor".
 * Owners when every one listed holds the Owner role, administrators otherwise.
 */
export function secondFactorHeadline(admins: readonly AdminWithoutSecondFactor[]): string {
  const n = admins.length;
  const [one, many] = admins.every((a) => a.owner) ? ['Owner', 'Owners'] : ['administrator', 'administrators'];
  return `${n} ${n === 1 ? `${one} has` : `${many} have`} no second factor`;
}

/** Whether any check fails. All passing shows nothing. */
export function anyFailing(security: SignInSecurity): boolean {
  return (
    security.adminsWithoutSecondFactor.length > 0 ||
    !security.adminMfaRequired ||
    !security.lockoutEnabled ||
    !security.breakGlassDesignated
  );
}
