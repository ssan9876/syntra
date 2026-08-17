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
  /**
   * Turns a page describing what the SERVER sent into the object ldapts hands
   * to a caller.
   *
   * These two are not the same thing, and the difference is the whole of this
   * bug. `SearchEntry.toObject` in ldapts@9.0.0 ends with
   *
   *     for (const attribute of requestAttributes)
   *       if (typeof result[attribute] === "undefined" &&
   *           !resultLCAttributes.has(attribute.toLocaleLowerCase()))
   *         result[attribute] = [];
   *
   * so **every requested attribute the server did not return comes back as an
   * empty array under the name it was requested by**. Ask for `member`, get
   * `member;range=0-1499`, and the entry also carries `member: []` -- a key
   * the directory never sent, injected by the library.
   *
   * A fixture that omits those keys models a server talking straight to the
   * caller with no library in between, which is a world that does not exist.
   * The walk tests passed for a year against it while the real code returned
   * `[]` on its first response for every group over the value-range limit.
   */
  const asLdaptsReturns = (
    page: Record<string, unknown> | undefined,
    requested: readonly string[],
  ): Record<string, unknown> => {
    const entry = { ...(page ?? {}) };
    const returned = new Set(Object.keys(entry).map((key) => key.toLowerCase()));
    for (const attribute of requested) {
      if (!returned.has(attribute.toLowerCase())) entry[attribute] = [];
    }
    return entry;
  };

  const searchReturning = (pages: (Record<string, unknown> | undefined)[]) => {
    let served = 0;
    return vi.fn(
      async (_base: string, options?: { attributes?: string[] }) => {
        const page = pages[served];
        served += 1;
        return {
          searchEntries: [asLdaptsReturns(page, options?.attributes ?? [])],
          searchReferences: [],
        };
      },
    );
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
      // `member: []` because ldapts adds it: the request asked for `member`
      // and the server answered under a different name. See asLdaptsReturns.
      searchEntries: [{ dn: 'CN=Big', member: [], 'member;range=0-1': ['a', 'b'] }],
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

  it('does not read the empty key ldapts injects as "this group has no members"', async () => {
    // The regression this whole finding is about, stated on its own.
    //
    // The server returned ONLY `member;range=0-1`. ldapts then wrote
    // `member: []` into the same entry because `member` is what was asked
    // for. A reader that looks for the plain name first finds that injected
    // key, reads no values out of it and returns [] -- on the FIRST response,
    // before the walk has issued a second request. Every group over Active
    // Directory's 1,500-value limit then reads as empty, with no readFailure,
    // and the diff proposes revoking it from everyone in it.
    const search = searchReturning([
      { dn: 'CN=Big', 'member;range=0-1': ['a', 'b'] },
      { dn: 'CN=Big', 'member;range=2-*': ['c'] },
    ]);
    const client = { search } as unknown as Parameters<typeof readRangedAttribute>[0];

    expect(
      await readRangedAttribute(client, 'CN=Big', 'member', { pageStep: 2 }),
    ).toEqual(['a', 'b', 'c']);
    // Two round trips. One means the injected key short-circuited the walk.
    expect(search).toHaveBeenCalledTimes(2);
    expect(search.mock.calls.map((call) => call[1]?.attributes?.[0])).toEqual([
      'member',
      'member;range=2-3',
    ]);
  });

  it('accepts a final window that the server answers with no values', async () => {
    // Asking past the end: the server marks the window final and sends
    // nothing in it, and ldapts also injects an empty key under the spec that
    // was requested. Both are empty; only one of them is the terminator, and
    // reading the injected one as "the server stopped answering" would turn a
    // complete read into a spurious read failure.
    const search = searchReturning([
      { dn: 'CN=Big', 'member;range=0-1': ['a', 'b'] },
      { dn: 'CN=Big', 'member;range=2-*': [] },
    ]);
    const client = { search } as unknown as Parameters<typeof readRangedAttribute>[0];

    expect(
      await readRangedAttribute(client, 'CN=Big', 'member', { pageStep: 2 }),
    ).toEqual(['a', 'b']);
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
