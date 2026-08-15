import type { TenantClient } from '@syntra/db';
import { listGroupsForUser } from '../directory/group-service.js';
import { activeContracts } from '../identity/contract-service.js';
import type { AuthContext, ContractFacts } from './types.js';

export interface AuthContextInput {
  userId: string;
  applicationId: string | null;
  sourceIp: string | null;
  now: Date;
}

/**
 * Assembles everything the policy engine is allowed to see, and nothing else.
 *
 * The contract list holds every contract in force at `now`, because a contract
 * condition matches if ANY active contract satisfies it. A user with no linked
 * person, or a person whose contracts have all ended, gets an empty list —
 * both are ordinary, and neither is an error.
 *
 * Only the four fields a rule may match on are copied across. Handing the
 * engine a whole Contract row would let a future rule reach for the cost
 * centre or the manager without anyone deciding that it should.
 */
export async function buildAuthContext(
  tx: TenantClient,
  input: AuthContextInput,
): Promise<AuthContext> {
  const groups = await listGroupsForUser(tx, input.userId);

  const user = await tx.user.findUnique({
    where: { id: input.userId },
    select: { personId: true },
  });

  let contracts: ContractFacts[] = [];
  if (user?.personId) {
    const rows = await activeContracts(tx, user.personId, input.now);
    contracts = rows.map((row) => ({
      department: row.department,
      jobTitle: row.jobTitle,
      employer: row.employer,
      location: row.location,
    }));
  }

  return {
    userId: input.userId,
    applicationId: input.applicationId,
    groupIds: groups.map((g) => g.id),
    contracts,
    sourceIp: input.sourceIp,
    now: input.now,
  };
}
