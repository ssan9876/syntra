import { describe, expect, it } from 'vitest';
import { dnDepth, planContainerStructure, rebaseDn } from './container-structure.js';

const BASE = 'DC=ssander,DC=local';
const ROOT = `OU=Syntra,${BASE}`;
const LOCAL = `OU=ssander.local,${ROOT}`;
const IT = `OU=IT,${LOCAL}`;

describe('dnDepth and rebaseDn', () => {
  it('counts RDNs on unescaped commas only', () => {
    expect(dnDepth(IT)).toBe(5);
    expect(dnDepth('OU=Sales\\, West,DC=acme,DC=test')).toBe(3);
    expect(dnDepth('')).toBe(0);
  });

  it('carries a DN at or below a moved container, on an RDN boundary', () => {
    const moves = [{ fromDn: `OU=IT,${ROOT}`, toDn: IT }];
    expect(rebaseDn(`OU=IT,${ROOT}`, moves)).toBe(IT);
    expect(rebaseDn(`OU=Help,OU=IT,${ROOT}`, moves)).toBe(`OU=Help,${IT}`);
    // `OU=XIT` ends with the same characters and is not below `OU=IT`.
    expect(rebaseDn(`OU=XIT,${ROOT}`, moves)).toBe(`OU=XIT,${ROOT}`);
  });
});

describe('planContainerStructure', () => {
  it('creates a two-level missing mirrored tree, including the missing root', () => {
    // Neither `OU=Syntra` nor `OU=ssander.local` exists. The unit rows ask
    // for `ssander.local` and `IT`; the root has no row and is an
    // intermediate.
    const structure = planContainerStructure({
      rows: [
        { id: 'r-it', state: 'desired', dn: IT, source: 'mirrored' },
        { id: 'r-local', state: 'desired', dn: LOCAL, source: 'mirrored' },
      ],
      existing: new Set([BASE.toLowerCase()]),
      baseDn: BASE,
    });
    expect([...structure.creates]).toEqual([
      ['r-it', IT],
      ['r-local', LOCAL],
    ]);
    expect(structure.intermediates).toEqual([ROOT]);
    expect(structure.moves).toEqual([]);
    expect(structure.incoming).toEqual(new Set([IT, LOCAL, ROOT].map((dn) => dn.toLowerCase())));
  });

  it('never invents the parent of a MANUAL row (Ruling P9, revised)', () => {
    const structure = planContainerStructure({
      rows: [{ id: 'r-it', state: 'desired', dn: `OU=IT,OU=Typo,${BASE}` }],
      existing: new Set(),
      baseDn: BASE,
    });
    expect(structure.intermediates).toEqual([]);
    expect([...structure.creates.keys()]).toEqual(['r-it']);
  });

  it('never creates the base or anything above it, nor a missing CN= ancestor', () => {
    const structure = planContainerStructure({
      rows: [{ id: 'r', state: 'desired', dn: `OU=IT,CN=Users,${BASE}`, source: 'mirrored' }],
      existing: new Set(),
      baseDn: BASE,
    });
    expect(structure.intermediates).toEqual([]);
  });

  it('moves a renamed unit once, and its children ride along', () => {
    // `IT` renamed to `Tech`: the sync re-derived both rows, and both keep
    // the DN the target confirmed. Only `IT` moves; `Help` goes with it.
    const TECH = `OU=Tech,${LOCAL}`;
    const structure = planContainerStructure({
      rows: [
        { id: 'r-help', state: 'live', dn: `OU=Help,${TECH}`, source: 'mirrored', previousDn: `OU=Help,${IT}` },
        { id: 'r-it', state: 'live', dn: TECH, source: 'mirrored', previousDn: IT },
        { id: 'r-local', state: 'live', dn: LOCAL, source: 'mirrored' },
      ],
      existing: new Set([BASE, ROOT, LOCAL, IT, `OU=Help,${IT}`].map((dn) => dn.toLowerCase())),
      baseDn: BASE,
    });
    expect(structure.moves).toEqual([
      { orgUnitContainerId: 'r-it', fromDn: IT, toDn: TECH, riderIds: ['r-help'] },
    ]);
    expect(structure.creates.size).toBe(0);
    expect(structure.intermediates).toEqual([]);
    expect(structure.incoming.has(`OU=Help,${TECH}`.toLowerCase())).toBe(true);
  });

  it('moves a re-parented unit under a parent this run creates, which is incoming', () => {
    const NEW_PARENT = `OU=Ops,${ROOT}`;
    const structure = planContainerStructure({
      rows: [
        { id: 'r-ops', state: 'desired', dn: NEW_PARENT, source: 'mirrored' },
        { id: 'r-it', state: 'live', dn: `OU=IT,${NEW_PARENT}`, source: 'mirrored', previousDn: IT },
      ],
      existing: new Set([BASE, ROOT, LOCAL, IT].map((dn) => dn.toLowerCase())),
      baseDn: BASE,
    });
    expect(structure.moves).toEqual([
      { orgUnitContainerId: 'r-it', fromDn: IT, toDn: `OU=IT,${NEW_PARENT}`, riderIds: [] },
    ]);
    expect([...structure.creates.keys()]).toEqual(['r-ops']);
    expect(structure.intermediates).toEqual([]);
  });

  it('does not move, or re-create, an OU somebody removed', () => {
    // The previous DN is gone from the target: that is `container_vanished`
    // for the person loop to report, never a silent re-create.
    const structure = planContainerStructure({
      rows: [{ id: 'r-it', state: 'live', dn: `OU=Tech,${LOCAL}`, source: 'mirrored', previousDn: IT }],
      existing: new Set([BASE, ROOT, LOCAL].map((dn) => dn.toLowerCase())),
      baseDn: BASE,
    });
    expect(structure.moves).toEqual([]);
    expect(structure.creates.size).toBe(0);
    expect(structure.incoming.size).toBe(0);
  });
});
