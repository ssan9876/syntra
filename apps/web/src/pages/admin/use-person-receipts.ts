import { useCallback, useEffect, useRef, useState } from 'react';
import { useToast } from '@syntra/ui';
import { ApiError, api } from '../../session/api.js';
import { isInFlight } from './lifecycle-verdict.js';
import type { PersonProvisionReceipt } from './provision-on-create.js';

const POLL_MS = 3000;

export interface PersonReceipts {
  /** `null` until the first answer, so "none recorded" is never guessed. */
  receipts: PersonProvisionReceipt[] | null;
  problem: string | null;
  /** 403: this operator may not read provisioning. Not an error to show. */
  forbidden: boolean;
  updatedAt: Date | null;
  refreshing: boolean;
  busy: string | null;
  reload(): void;
  retry(receipt: PersonProvisionReceipt): Promise<void>;
}

/**
 * One person's provisioning receipts, shared by the verdict in the header,
 * the summary and the evidence table — one fetch, so the three cannot show
 * different moments.
 *
 * It polls only while something is still moving on its own (queued,
 * planning, applying). The old panel polled every three seconds forever,
 * including on a person whose every target had been observed a month ago;
 * a settled receipt does not change until somebody retries it, and a retry
 * restarts the poll.
 */
export function usePersonReceipts(personId: string): PersonReceipts {
  const toast = useToast();
  const [receipts, setReceipts] = useState<PersonProvisionReceipt[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let current = true;
    async function load() {
      setRefreshing(true);
      let keepPolling = true;
      try {
        const data = await api<{ receipts: PersonProvisionReceipt[] }>(`/api/admin/persons/${personId}/provision-receipts`);
        if (!current) return;
        const rows = Array.isArray(data.receipts) ? data.receipts : [];
        setReceipts(rows);
        setProblem(null);
        setUpdatedAt(new Date());
        keepPolling = rows.some((row) => isInFlight(row.status));
      } catch (cause) {
        if (!current) return;
        if (cause instanceof ApiError && cause.problem.status === 403) {
          setForbidden(true);
          keepPolling = false;
        } else {
          setProblem('Could not load saved provisioning receipts.');
        }
      } finally {
        if (current) setRefreshing(false);
      }
      if (current && keepPolling) timer.current = setTimeout(() => { void load(); }, POLL_MS);
    }
    void load();
    return () => {
      current = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [personId, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  const retry = useCallback(async (receipt: PersonProvisionReceipt) => {
    setBusy(receipt.id);
    try {
      await api(`/api/admin/persons/${personId}/provision-receipts/${receipt.id}/retry`, { method: 'POST', body: '{}' });
      toast({ tone: 'success', title: `Retry queued for ${receipt.targetName}` });
      setNonce((n) => n + 1);
    } catch (cause) {
      setProblem(cause instanceof ApiError
        ? `Could not retry ${receipt.targetName}: ${cause.problem.detail ?? cause.problem.title}`
        : `Could not retry ${receipt.targetName}. Your saved records have been kept.`);
    } finally {
      setBusy(null);
    }
  }, [personId, toast]);

  return { receipts, problem, forbidden, updatedAt, refreshing, busy, reload, retry };
}
