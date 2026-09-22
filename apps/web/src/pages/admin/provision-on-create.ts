import { api } from '../../session/api.js';

export interface PersonProvisionReceipt {
  id: string;
  targetSystemId: string;
  targetName: string;
  status: string;
  runId: string | null;
  runIds: string[];
  message: string | null;
  createdAt: string;
}

/** The server owns planning, exact run correlation and person-scoped application. */
export async function provisionForPerson(targetId: string, personId: string): Promise<PersonProvisionReceipt[]> {
  const result = await api<{ receipts: PersonProvisionReceipt[] }>(`/api/admin/persons/${personId}/provision-receipts`, {
    method: 'POST',
    body: JSON.stringify({ requestKey: crypto.randomUUID(), targetIds: [targetId] }),
  });
  return result.receipts;
}
