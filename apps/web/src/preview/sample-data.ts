/** Read-only fixtures scoped exclusively to preview.html. No backend requests. */
export function installPreviewData() {
  const recent = new Date(Date.now() - 120_000).toISOString();
  const permissions = ['directory.read', 'identity.read', 'privacy.manage', 'access.read', 'policy.read', 'automate.read', 'govern.read', 'sync.read', 'provision.read', 'rbac.manage', 'audit.read', 'tenant.manage'];
  const data: Record<string, unknown> = {
    '/api/branding': {},
    '/api/auth/session': { userId: 'preview-admin', displayName: 'Alex Morgan', scope: 'admin', mayElevate: true, permissions },
    '/api/admin/status': { overall: 'operational', generatedAt: recent, components: [], degradation: { writeStop: { active: false }, targetWriteStops: [], staleReadiness: [], connectorOutages: [], queueReadable: true } },
    '/api/admin/job-health': { queueReadable: true, findings: [] },
    '/api/admin/directory/summary': { people: { total: 428, active: 412, withoutAccount: 2 }, accounts: { total: 440, active: 426, locked: 0 } },
    '/api/admin/users/unlinked': { accounts: [{ id: 'unlinked-1' }, { id: 'unlinked-2' }] },
    '/api/admin/employee-work': { lanes: { action: 3, waiting: 1, blocked: 0, overdue: 0 } },
    '/api/admin/targets': { targets: [
      { id: 'ad', name: 'Active Directory', type: 'activeDirectory', enabled: true, schedule: '*/15 * * * *', lastRunAt: recent, consecutiveSkippedRuns: 0 },
      { id: 'entra', name: 'Microsoft Entra ID', type: 'entra', enabled: true, schedule: '*/15 * * * *', lastRunAt: recent, consecutiveSkippedRuns: 0 },
      { id: 'inventory', name: 'Snipe-IT', type: 'httpJson', enabled: true, schedule: '*/15 * * * *', lastRunAt: recent, consecutiveSkippedRuns: 0 },
    ] },
    '/api/admin/sources': { sources: [{ id: 'hr', name: 'HR directory', type: 'ldap', enabled: true, schedule: '*/15 * * * *', lastRunAt: recent }] },
    '/api/admin/applications': { applications: Array.from({ length: 12 }, (_, id) => ({ id })) },
    '/api/admin/incidents': { incidents: [] },
    '/api/admin/users': { users: [{ id: 'preview-admin', displayName: 'Alex Morgan' }] },
    '/api/admin/audit': { events: ['auth.elevate', 'auth.login', 'provision.run.apply', 'sync.run.apply'].map((action, i) => ({ id: `e${i}`, occurredAt: recent, actorUserId: 'preview-admin', action, outcome: 'success' })) },
    '/api/admin/tenant/sign-in-security': { adminsWithoutSecondFactor: [], adminMfaRequired: true, lockoutEnabled: true, breakGlassDesignated: true },
  };
  const realFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), window.location.origin);
    if (url.origin !== window.location.origin || !url.pathname.startsWith('/api/')) return realFetch(input, init);
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    if (method !== 'GET') return Response.json({ title: 'Read-only design preview', status: 405 }, { status: 405 });
    if (!(url.pathname in data)) return Response.json({ title: 'Not available in this preview', status: 404 }, { status: 404 });
    return Response.json(data[url.pathname]);
  };
}
