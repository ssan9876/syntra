import { describe, expect, it } from 'vitest';
import { absentAnchors, correlate, type ExistingObject } from './correlate.js';
import type { DirectoryObject } from './mapping.js';

const SOURCE = 'src-1';
const OTHER_SOURCE = 'src-2';

const obj = (
  anchor: string,
  correlationValue: string,
  dn = `cn=${correlationValue},dc=acme,dc=test`,
): DirectoryObject => ({
  anchor,
  objectType: 'user',
  dn,
  fields: { login: correlationValue },
  correlationValue,
  memberDns: [],
});

const existing = (
  id: string,
  correlationValue: string,
  sourceId: string | null,
  sourceAnchor: string | null,
  status = 'active',
): ExistingObject => ({
  id,
  objectType: 'user',
  sourceId,
  sourceAnchor,
  correlationValue,
  status,
});

describe('correlate', () => {
  it('matches on the anchor even when every other field changed', () => {
    // This is the organizational-unit move: same person, new DN, new login.
    const result = correlate(
      [obj('a1', 'jo.doe', 'cn=Jo,ou=Learning,dc=acme,dc=test')],
      [existing('u1', 'jdoe', SOURCE, 'a1')],
      SOURCE,
    );
    expect(result[0]!.kind).toBe('matched');
    if (result[0]!.kind !== 'matched') return;
    expect(result[0]!.existing.id).toBe('u1');
  });

  it('treats an unseen anchor with no correlation match as new', () => {
    const result = correlate([obj('a9', 'newbie')], [], SOURCE);
    expect(result[0]!.kind).toBe('new');
  });

  it('reports a match against a locally managed account as a conflict', () => {
    // Adopting silently would let anyone able to write to the directory
    // capture an existing Syntra account.
    const result = correlate(
      [obj('a1', 'admin')],
      [existing('u1', 'admin', null, null)],
      SOURCE,
    );
    expect(result[0]!.kind).toBe('conflict');
    if (result[0]!.kind !== 'conflict') return;
    expect(result[0]!.reason).toMatch(/locally managed/i);
  });

  it('reports a match against another source as a conflict, never a transfer', () => {
    const result = correlate(
      [obj('a1', 'jdoe')],
      [existing('u1', 'jdoe', OTHER_SOURCE, 'b7')],
      SOURCE,
    );
    expect(result[0]!.kind).toBe('conflict');
    if (result[0]!.kind !== 'conflict') return;
    expect(result[0]!.reason).toMatch(/another source/i);
  });

  it('does not blame a second directory for a delete-and-recreate collision', () => {
    // Same source, new anchor: the entry was deleted and recreated, so the
    // name matches but the immutable id does not. Still a conflict, but an
    // administrator told to look for "another source" would be hunting a
    // directory that does not exist.
    const result = correlate(
      [obj('a2', 'jdoe')],
      [existing('u1', 'jdoe', SOURCE, 'a1')],
      SOURCE,
    );
    expect(result[0]!.kind).toBe('conflict');
    if (result[0]!.kind !== 'conflict') return;
    expect(result[0]!.reason).not.toMatch(/another source/i);
    expect(result[0]!.reason).toMatch(/deleted and recreated/i);
  });

  it('prefers the anchor over the correlation value', () => {
    // Two rows could both look plausible; the anchor is authoritative.
    const result = correlate(
      [obj('a1', 'shared')],
      [
        existing('u-anchor', 'different', SOURCE, 'a1'),
        existing('u-value', 'shared', null, null),
      ],
      SOURCE,
    );
    expect(result[0]!.kind).toBe('matched');
    if (result[0]!.kind !== 'matched') return;
    expect(result[0]!.existing.id).toBe('u-anchor');
  });

  it('correlates case-insensitively', () => {
    const result = correlate(
      [obj('a1', 'jdoe')],
      [existing('u1', 'JDoe', null, null)],
      SOURCE,
    );
    expect(result[0]!.kind).toBe('conflict');
  });
});

describe('absentAnchors', () => {
  it('returns rows from this source whose anchor was not read', () => {
    const gone = absentAnchors(
      [obj('a1', 'jdoe')],
      [existing('u1', 'jdoe', SOURCE, 'a1'), existing('u2', 'sroe', SOURCE, 'a2')],
      SOURCE,
    );
    expect(gone.map((e) => e.id)).toEqual(['u2']);
  });

  it('never returns a locally managed row', () => {
    const gone = absentAnchors(
      [],
      [existing('u1', 'admin', null, null)],
      SOURCE,
    );
    expect(gone).toEqual([]);
  });

  it('never returns a row belonging to another source', () => {
    const gone = absentAnchors(
      [],
      [existing('u1', 'jdoe', OTHER_SOURCE, 'b7')],
      SOURCE,
    );
    expect(gone).toEqual([]);
  });

  it('does not report an already inactive row again', () => {
    const gone = absentAnchors(
      [],
      [existing('u1', 'jdoe', SOURCE, 'a1', 'inactive')],
      SOURCE,
    );
    expect(gone).toEqual([]);
  });

  it('does not report a record the source returned but we could not map', () => {
    // Absence means the source no longer has the object, not that we failed
    // to understand it. Otherwise one missing attribute reads as a departure.
    const gone = absentAnchors(
      [],
      [existing('u1', 'jdoe', SOURCE, 'a1')],
      SOURCE,
      new Set(['a1']),
    );
    expect(gone).toEqual([]);
  });

  it('still reports a row whose anchor was in neither the read nor the failures', () => {
    const gone = absentAnchors(
      [],
      [existing('u1', 'jdoe', SOURCE, 'a1'), existing('u2', 'sroe', SOURCE, 'a2')],
      SOURCE,
      new Set(['a1']),
    );
    expect(gone.map((e) => e.id)).toEqual(['u2']);
  });
});
