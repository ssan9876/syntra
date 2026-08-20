import { describe, expect, it } from 'vitest';
import { diffMemberships, diffObjects } from './diff.js';
import type { Correlation, ExistingObject } from './correlate.js';
import type { DirectoryObject } from './mapping.js';

const object = (
  anchor: string,
  fields: Record<string, string>,
  objectType: DirectoryObject['objectType'] = 'user',
): DirectoryObject => ({
  anchor,
  objectType,
  dn: `cn=${anchor},dc=acme,dc=test`,
  fields,
  correlationValue: fields.login ?? fields.name ?? anchor,
  memberDns: [],
});

const existing = (
  id: string,
  status = 'active',
  objectType: ExistingObject['objectType'] = 'user',
): ExistingObject => ({
  id,
  objectType,
  sourceId: 'src-1',
  sourceAnchor: 'a1',
  correlationValue: 'jdoe',
  status,
});

describe('diffObjects', () => {
  it('proposes a create for a new object', () => {
    const changes = diffObjects(
      [{ kind: 'new', object: object('a1', { login: 'jdoe' }) }],
      [],
      new Map(),
    );
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      changeType: 'create_user',
      targetId: null,
      sourceAnchor: 'a1',
      status: 'proposed',
    });
    expect(changes[0]!.after).toEqual({ login: 'jdoe' });
  });

  it('proposes nothing when every mapped field already matches', () => {
    // The common case by far. A run over an unchanged directory must be empty,
    // or every run would look like it did something.
    const changes = diffObjects(
      [
        {
          kind: 'matched',
          object: object('a1', { login: 'jdoe', email: 'j@acme.test' }),
          existing: existing('u1'),
        },
      ],
      [],
      new Map([['u1', { login: 'jdoe', email: 'j@acme.test' }]]),
    );
    expect(changes).toEqual([]);
  });

  it('proposes an update carrying only the changed fields', () => {
    const changes = diffObjects(
      [
        {
          kind: 'matched',
          object: object('a1', { login: 'jdoe', email: 'new@acme.test' }),
          existing: existing('u1'),
        },
      ],
      [],
      new Map([['u1', { login: 'jdoe', email: 'old@acme.test' }]]),
    );
    expect(changes).toHaveLength(1);
    expect(changes[0]!.changeType).toBe('update_user');
    expect(changes[0]!.before).toEqual({ email: 'old@acme.test' });
    expect(changes[0]!.after).toEqual({ email: 'new@acme.test' });
  });

  it('proposes a reactivation for a matched object that is inactive', () => {
    const changes = diffObjects(
      [
        {
          kind: 'matched',
          object: object('a1', { login: 'jdoe' }),
          existing: existing('u1', 'inactive'),
        },
      ],
      [],
      new Map([['u1', { login: 'jdoe' }]]),
    );
    expect(changes.map((c) => c.changeType)).toEqual(['reactivate_user']);
  });

  it('proposes a deactivation for an absent object', () => {
    const changes = diffObjects([], [existing('u2')], new Map());
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      changeType: 'deactivate_user',
      targetId: 'u2',
    });
  });

  it('records a conflict as a change with conflict status and no action', () => {
    const changes = diffObjects(
      [
        {
          kind: 'conflict',
          object: object('a1', { login: 'admin' }),
          existing: existing('u1'),
          reason: 'matches a locally managed object',
        },
      ],
      [],
      new Map(),
    );
    expect(changes[0]!.status).toBe('conflict');
    expect(changes[0]!.message).toMatch(/locally managed/);
  });

  it('uses the group change types for a group', () => {
    const changes = diffObjects(
      [{ kind: 'new', object: object('g1', { name: 'Nurses' }, 'group') }],
      [],
      new Map(),
    );
    expect(changes[0]!.changeType).toBe('create_group');
    expect(changes[0]!.targetType).toBe('Group');
  });

  it('proposes deactivation for an absent group', () => {
    const changes = diffObjects([], [existing('g1', 'active', 'group')], new Map());
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      changeType: 'deactivate_group',
      targetType: 'Group',
      targetId: 'g1',
    });
  });

  it('proposes no change for an absent org unit', () => {
    // Org units carry scoped role assignments; their removal is a human decision.
    const changes = diffObjects([], [existing('ou1', 'active', 'orgUnit')], new Map());
    expect(changes).toEqual([]);
  });

  it('proposes reactivate_group — NOT update_group — for a group that came back', () => {
    // This asserted `update_group` for a long time, and `update_group` could
    // never apply. `status` is not a field a mapping may write — if it were, a
    // source attribute could deactivate people — so `rejectUnassignable`
    // refused the change on every run, forever, and the group stayed dead with
    // its memberships intact and granting nothing.
    //
    // Deactivation is chosen over deletion precisely because it is
    // recoverable. A group that cannot come back is deleted in all but name,
    // and `reactivate_user` has been the working half of this pair all along.
    const changes = diffObjects(
      [
        {
          kind: 'matched',
          object: object('g1', { name: 'Nurses' }, 'group'),
          existing: existing('g1', 'inactive', 'group'),
        },
      ],
      [],
      new Map([['g1', { name: 'Nurses' }]]),
    );
    expect(changes).toHaveLength(1);
    expect(changes[0]!.changeType).toBe('reactivate_group');
    expect(changes[0]!.after).toEqual({ status: 'active' });
  });

  it('proposes no status change for a matched but inactive org unit', () => {
    // Org units have no status column, so no reactivation change.
    const changes = diffObjects(
      [
        {
          kind: 'matched',
          object: object('ou1', { name: 'Division' }, 'orgUnit'),
          existing: existing('ou1', 'inactive', 'orgUnit'),
        },
      ],
      [],
      new Map([['ou1', { name: 'Division' }]]),
    );
    expect(changes).toEqual([]);
  });
});

describe('diffMemberships', () => {
  it('proposes adding a member that is present in the source only', () => {
    const changes = diffMemberships(
      [{ groupAnchor: 'g1', memberAnchors: ['a1', 'a2'] }],
      [{ groupAnchor: 'g1', memberAnchors: ['a1'] }],
      new Set(),
    );
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ changeType: 'add_member' });
    expect(changes[0]!.after).toEqual({ groupAnchor: 'g1', memberAnchor: 'a2' });
  });

  it('proposes removing a member that is present locally only', () => {
    const changes = diffMemberships(
      [{ groupAnchor: 'g1', memberAnchors: ['a1'] }],
      [{ groupAnchor: 'g1', memberAnchors: ['a1', 'a2'] }],
      new Set(),
    );
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ changeType: 'remove_member' });
  });

  it('proposes nothing when membership matches regardless of order', () => {
    const changes = diffMemberships(
      [{ groupAnchor: 'g1', memberAnchors: ['a2', 'a1'] }],
      [{ groupAnchor: 'g1', memberAnchors: ['a1', 'a2'] }],
      new Set(),
    );
    expect(changes).toEqual([]);
  });

  it('ignores a group the source did not report at all', () => {
    // Absence of a group from the read is handled by diffObjects as a
    // deactivation; it must not also empty the group's membership.
    const changes = diffMemberships(
      [],
      [{ groupAnchor: 'g9', memberAnchors: ['a1'] }],
      new Set(),
    );
    expect(changes).toEqual([]);
  });

  it('proposes no removal for a group whose membership could not be read in full', () => {
    // The member Syntra holds is missing from `desired` because its DN
    // resolved to nothing the source returned — a member who moved between
    // organizational units a moment ago, one outside the configured search
    // base, or a nested group. Every one of those is a gap in OUR read, and
    // none of them is a person who left the group.
    const changes = diffMemberships(
      [{ groupAnchor: 'g1', memberAnchors: [] }],
      [{ groupAnchor: 'g1', memberAnchors: ['a1'] }],
      new Set(['g1']),
    );
    expect(changes).toEqual([]);
  });

  it('still proposes the additions for a group whose read was incomplete', () => {
    // An add is safe on a partial read: the source named that member. Only the
    // removals are the ones our own failure could invent.
    const changes = diffMemberships(
      [{ groupAnchor: 'g1', memberAnchors: ['a2'] }],
      [{ groupAnchor: 'g1', memberAnchors: ['a1'] }],
      new Set(['g1']),
    );
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ changeType: 'add_member' });
    expect(changes[0]!.after).toEqual({ groupAnchor: 'g1', memberAnchor: 'a2' });
  });

  it('leaves a group whose read WAS complete free to remove members', () => {
    // The guard is per group, not per run: one group with an unreadable member
    // must not freeze the membership of every other group in the directory.
    const changes = diffMemberships(
      [
        { groupAnchor: 'g1', memberAnchors: [] },
        { groupAnchor: 'g2', memberAnchors: [] },
      ],
      [
        { groupAnchor: 'g1', memberAnchors: ['a1'] },
        { groupAnchor: 'g2', memberAnchors: ['a2'] },
      ],
      new Set(['g1']),
    );
    expect(changes).toHaveLength(1);
    expect(changes[0]!.before).toEqual({ groupAnchor: 'g2', memberAnchor: 'a2' });
  });
});
