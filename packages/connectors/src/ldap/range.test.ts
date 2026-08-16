import { describe, expect, it, vi } from 'vitest';
import { RANGE_STEP, parseRangeKey, readRangedAttribute } from './range.js';

describe('parseRangeKey', () => {
  it('reads a bounded window', () => {
    expect(parseRangeKey('member;range=0-1499')).toEqual({
      attribute: 'member',
      low: 0,
      high: 1499,
    });
  });

  it('reads the final window, which Active Directory marks with an asterisk', () => {
    // The last window is the one that says the enumeration is finished. Miss
    // it and the loop either stops early -- truncating -- or never stops.
    expect(parseRangeKey('member;range=3000-*')).toEqual({
      attribute: 'member',
      low: 3000,
      high: '*',
    });
  });

  it('is case-insensitive, because LDAP attribute names are', () => {
    expect(parseRangeKey('Member;Range=0-1499')).toEqual({
      attribute: 'Member',
      low: 0,
      high: 1499,
    });
  });

  it('reads uniqueMember as well as member', () => {
    expect(parseRangeKey('uniqueMember;range=0-99')).toEqual({
      attribute: 'uniqueMember',
      low: 0,
      high: 99,
    });
  });

  it('ignores a plain attribute name', () => {
    expect(parseRangeKey('member')).toBeUndefined();
    expect(parseRangeKey('memberOf')).toBeUndefined();
  });
});

describe('readRangedAttribute', () => {
  const searchReturning = (pages: Record<string, unknown>[]) => {
    const search = vi.fn();
    for (const page of pages) {
      search.mockResolvedValueOnce({ searchEntries: [page], searchReferences: [] });
    }
    return search;
  };

  it('walks every window and concatenates them in order', async () => {
    const search = searchReturning([
      { dn: 'CN=Big,DC=acme,DC=test', 'member;range=0-1': ['a', 'b'] },
      { dn: 'CN=Big,DC=acme,DC=test', 'member;range=2-3': ['c', 'd'] },
      { dn: 'CN=Big,DC=acme,DC=test', 'member;range=4-*': ['e'] },
    ]);
    const client = { search } as unknown as Parameters<typeof readRangedAttribute>[0];

    const values = await readRangedAttribute(client, 'CN=Big,DC=acme,DC=test', 'member', {
      pageStep: 2,
    });

    expect(values).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(search).toHaveBeenCalledTimes(3);
  });

  it('stops at the asterisk window even when it is full', async () => {
    const search = searchReturning([
      { dn: 'CN=Big', 'member;range=0-1': ['a', 'b'] },
      { dn: 'CN=Big', 'member;range=2-*': ['c', 'd'] },
    ]);
    const client = { search } as unknown as Parameters<typeof readRangedAttribute>[0];

    const values = await readRangedAttribute(client, 'CN=Big', 'member', { pageStep: 2 });

    expect(values).toEqual(['a', 'b', 'c', 'd']);
    // Not a third call. The asterisk is the terminator, not the count.
    expect(search).toHaveBeenCalledTimes(2);
  });

  it('returns a plain untruncated attribute in one call', async () => {
    const search = searchReturning([{ dn: 'CN=Small', member: ['a', 'b'] }]);
    const client = { search } as unknown as Parameters<typeof readRangedAttribute>[0];

    const values = await readRangedAttribute(client, 'CN=Small', 'member', {
      pageStep: RANGE_STEP,
    });

    expect(values).toEqual(['a', 'b']);
    expect(search).toHaveBeenCalledTimes(1);
  });

  it('returns an empty list for a group that genuinely has no members', async () => {
    // A group with no members and a group whose membership could not be read
    // must not look the same. This one really is empty, and says so.
    const search = searchReturning([{ dn: 'CN=Empty' }]);
    const client = { search } as unknown as Parameters<typeof readRangedAttribute>[0];

    expect(
      await readRangedAttribute(client, 'CN=Empty', 'member', { pageStep: RANGE_STEP }),
    ).toEqual([]);
  });

  it('refuses to return a partial result when a window fails', async () => {
    // Half a membership is the single most dangerous value in this subsystem.
    // If the walk cannot finish, it throws and the caller marks the record a
    // read failure -- it never hands back what it managed to collect.
    const search = vi.fn();
    search.mockResolvedValueOnce({
      searchEntries: [{ dn: 'CN=Big', 'member;range=0-1': ['a', 'b'] }],
      searchReferences: [],
    });
    search.mockRejectedValueOnce(new Error('busy'));
    const client = { search } as unknown as Parameters<typeof readRangedAttribute>[0];

    await expect(
      readRangedAttribute(client, 'CN=Big', 'member', { pageStep: 2 }),
    ).rejects.toThrow('busy');
  });

  it('refuses to return a partial result when the server stops answering partway', async () => {
    // The single most dangerous shape in this task, and the one an early
    // return hides. The first response is ranged, so a walk is under way; the
    // second comes back with neither a plain `member` nor a ranged one -- a
    // transient, a referral, a sizelimit, a replication hiccup. Reading that
    // as "the object holds no more values" hands back 2 of 4,000 members as if
    // it were the whole membership, and the diff then proposes revoking the
    // group from 3,998 people.
    //
    // The same shape on the FIRST request genuinely does mean "no values", and
    // the test above pins that. The difference is whether a walk has started.
    const search = searchReturning([
      { dn: 'CN=Big', 'member;range=0-1': ['a', 'b'] },
      { dn: 'CN=Big' },
    ]);
    const client = { search } as unknown as Parameters<typeof readRangedAttribute>[0];

    await expect(
      readRangedAttribute(client, 'CN=Big', 'member', { pageStep: 2 }),
    ).rejects.toThrow(/partway through a ranged read/);
  });

  it('refuses a server that returns a window that does not advance', async () => {
    // A server answering the same window forever would otherwise spin here
    // until the process was killed, holding an LDAP connection open.
    const search = searchReturning([
      { dn: 'CN=Big', 'member;range=0-1': ['a', 'b'] },
      { dn: 'CN=Big', 'member;range=0-1': ['a', 'b'] },
    ]);
    const client = { search } as unknown as Parameters<typeof readRangedAttribute>[0];

    await expect(
      readRangedAttribute(client, 'CN=Big', 'member', { pageStep: 2 }),
    ).rejects.toThrow(/did not advance/);
  });
});
