import { randomUUID } from 'node:crypto';
import { ConnectorError, type ConnectorDefinition } from '../server.js';
import type { Account, Entitlement, WriteOperationName, WriteResultBody } from '../protocol.js';

/**
 * An example connector over an in-memory store.
 *
 * Small enough to read in one sitting and complete enough to pass
 * certification, so it is the template for a real one: replace the `Map`s
 * with calls to your system and keep the rules. Those rules are the parts
 * worth copying:
 *
 * - `create_account` records the action id on the account and, asked again
 *   with the same id, returns the same anchor. Asked with a login that
 *   another action created, it answers `conflict`.
 * - `update_account` replaces the managed attributes as a whole.
 * - Every write to an anchor that does not exist answers `not_found`.
 * - `delete_account` deletes only a disabled account.
 * - A membership read is all or an error, never part of a list.
 */

export interface StoredAccount {
  anchor: string;
  correlationKey: string;
  attributes: Record<string, string[]>;
  enabled: boolean;
  /** The `actionId` of the `create_account` that made it. */
  createdBy: string;
}

export interface InMemoryConnectorOptions {
  name?: string;
  entitlements?: Entitlement[];
  /** Containers to list. Setting any makes the connector place accounts in them. */
  containers?: string[];
}

export interface InMemoryStore {
  accounts: Map<string, StoredAccount>;
  entitlements: Map<string, Entitlement>;
  /** Entitlement id to member anchors. */
  members: Map<string, Set<string>>;
  containers: string[];
  /** The next write of this kind fails this way, once. For tests. */
  failNext(op: WriteOperationName, failure: ConnectorError): void;
  /** The next call of every kind waits this long first. For tests. */
  delayMs: number;
}

export function createInMemoryConnector(options: InMemoryConnectorOptions = {}): {
  connector: ConnectorDefinition;
  store: InMemoryStore;
} {
  const pending = new Map<WriteOperationName, ConnectorError>();
  const store: InMemoryStore = {
    accounts: new Map(),
    entitlements: new Map((options.entitlements ?? []).map((e) => [e.id, e])),
    members: new Map((options.entitlements ?? []).map((e) => [e.id, new Set<string>()])),
    containers: options.containers ?? [],
    failNext: (op, failure) => {
      pending.set(op, failure);
    },
    delayMs: 0,
  };

  const pause = async (signal: AbortSignal) => {
    if (store.delayMs <= 0) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, store.delayMs);
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    });
  };

  const injected = (op: WriteOperationName) => {
    const failure = pending.get(op);
    if (failure) {
      pending.delete(op);
      throw failure;
    }
  };

  const existing = (anchor: string): StoredAccount => {
    const account = store.accounts.get(anchor);
    if (!account) throw new ConnectorError('not_found', `Account ${anchor} not found.`);
    return account;
  };

  const entitlement = (id: string): Set<string> => {
    const members = store.members.get(id);
    if (!members) throw new ConnectorError('not_found', `Entitlement ${id} not found.`);
    return members;
  };

  const toWire = (account: StoredAccount): Account => ({
    anchor: account.anchor,
    correlationKey: account.correlationKey,
    attributes: account.attributes,
    enabled: account.enabled,
  });

  const ok = (message: string, anchor?: string): WriteResultBody =>
    anchor === undefined ? { ok: true, message } : { ok: true, message, anchor };

  const page = <T>(items: T[], cursor: string | null, pageSize: number) => {
    const start = cursor === null ? 0 : Number(cursor);
    const slice = items.slice(start, start + pageSize);
    const next = start + slice.length;
    return { items: slice, nextCursor: next < items.length ? String(next) : null };
  };

  const connector: ConnectorDefinition = {
    name: options.name ?? 'In-memory example',
    version: '1.0.0',
    schema: { objectClasses: ['user'], attributes: ['displayName', 'mail', 'title'] },
    placesAccountsInContainers: store.containers.length > 0,

    async test(context) {
      await pause(context.signal);
      return { ok: true, message: `${store.accounts.size} accounts.` };
    },

    accounts: {
      async list({ cursor, pageSize }, context) {
        await pause(context.signal);
        const { items, nextCursor } = page([...store.accounts.values()], cursor, pageSize);
        return { accounts: items.map(toWire), nextCursor };
      },
      async read({ anchor }, context) {
        await pause(context.signal);
        const account = store.accounts.get(anchor);
        if (!account) return { account: null, entitlementIds: [], entitlementsComplete: true };
        const held = [...store.members].filter(([, members]) => members.has(anchor)).map(([id]) => id);
        return { account: toWire(account), entitlementIds: held, entitlementsComplete: true };
      },
    },

    entitlements: {
      async list({ cursor, pageSize }, context) {
        await pause(context.signal);
        const { items, nextCursor } = page([...store.entitlements.values()], cursor, pageSize);
        return { entitlements: items, nextCursor };
      },
      async members({ entitlementId }, context) {
        await pause(context.signal);
        return { members: [...entitlement(entitlementId)] };
      },
    },

    ...(store.containers.length > 0
      ? {
          containers: {
            async list({ cursor, pageSize }: { cursor: string | null; pageSize: number }) {
              const { items, nextCursor } = page(store.containers, cursor, pageSize);
              return { containers: items.map((dn) => ({ dn })), nextCursor };
            },
          },
        }
      : {}),

    write: {
      async create_account(op, context) {
        await pause(context.signal);
        injected(op.op);
        const taken = [...store.accounts.values()].find(
          (a) => a.correlationKey.toLowerCase() === op.correlationKey.toLowerCase(),
        );
        if (taken) {
          // The retry of a create that already happened: same anchor.
          if (taken.createdBy === op.actionId) return ok('Already created.', taken.anchor);
          return {
            ok: false,
            failure: 'conflict',
            message: `Account ${op.correlationKey} already exists and was not created by this action.`,
          };
        }
        const anchor = randomUUID();
        // The password would go to the target here. It is never stored or logged.
        void op.initialPassword;
        store.accounts.set(anchor, {
          anchor,
          correlationKey: op.correlationKey,
          attributes: structuredClone(op.attributes),
          enabled: op.enabled,
          createdBy: op.actionId,
        });
        return ok('Created.', anchor);
      },
      async update_account(op, context) {
        await pause(context.signal);
        injected(op.op);
        existing(op.anchor).attributes = structuredClone(op.attributes);
        return ok('Updated.');
      },
      async enable_account(op) {
        injected(op.op);
        existing(op.anchor).enabled = true;
        return ok('Enabled.');
      },
      async disable_account(op) {
        injected(op.op);
        existing(op.anchor).enabled = false;
        return ok('Disabled.');
      },
      async rename_account(op) {
        injected(op.op);
        const account = existing(op.anchor);
        const clash = [...store.accounts.values()].find(
          (a) => a.anchor !== op.anchor && a.correlationKey.toLowerCase() === op.correlationKey.toLowerCase(),
        );
        if (clash) throw new ConnectorError('conflict', `Account ${op.correlationKey} already exists.`);
        account.correlationKey = op.correlationKey;
        return ok('Renamed.');
      },
      async archive_account(op) {
        injected(op.op);
        existing(op.anchor).enabled = false;
        for (const id of op.entitlementDns) store.members.get(id)?.delete(op.anchor);
        return ok('Archived.');
      },
      async delete_account(op) {
        injected(op.op);
        const account = existing(op.anchor);
        if (account.enabled) {
          throw new ConnectorError('rejected', `Account ${op.anchor} is enabled. Only a disabled account is deleted.`);
        }
        store.accounts.delete(op.anchor);
        for (const members of store.members.values()) members.delete(op.anchor);
        return ok('Deleted.');
      },
      async grant_entitlement(op) {
        injected(op.op);
        existing(op.anchor);
        entitlement(op.entitlementId).add(op.anchor);
        return ok('Granted.');
      },
      async revoke_entitlement(op) {
        injected(op.op);
        existing(op.anchor);
        entitlement(op.entitlementId).delete(op.anchor);
        return ok('Revoked.');
      },
    },
  };

  return { connector, store };
}
