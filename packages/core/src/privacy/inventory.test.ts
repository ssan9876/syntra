import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Prisma, prisma } from '@syntra/db';
import { DATA_INVENTORY, type LinkKind } from './inventory.js';
import { renderDataInventory } from './inventory-doc.js';

/**
 * The inventory against the schema it describes.
 *
 * These are the tests that make the inventory a control rather than a
 * document: a column added to a Prisma model without being classified here
 * fails the build, so the only way to ship a new column is to say what it
 * holds and what an erasure does to it.
 */

const models = Prisma.dmmf.datamodel.models;
const columnsOf = (model: (typeof models)[number]) => model.fields.filter((f) => f.kind !== 'object');

describe('the data inventory', () => {
  it('has an entry for every model, and none for a model that does not exist', () => {
    expect(Object.keys(DATA_INVENTORY).sort()).toEqual(models.map((m) => m.name).sort());
  });

  it('classifies every column of every model, and no column that does not exist', () => {
    const unclassified: string[] = [];
    const stale: string[] = [];
    for (const model of models) {
      const entry = DATA_INVENTORY[model.name];
      if (entry === undefined) continue;
      const known = new Set(entry.fields.map((f) => f.name));
      const actual = new Set(columnsOf(model).map((f) => f.name));
      for (const name of actual) if (!known.has(name)) unclassified.push(`${model.name}.${name}`);
      for (const name of known) if (!actual.has(name)) stale.push(`${model.name}.${name}`);
    }
    expect(unclassified, 'columns with no classification in packages/core/src/privacy/inventory.ts').toEqual([]);
    expect(stale, 'inventory entries for columns the schema no longer has').toEqual([]);
  });

  it('links only through columns that exist, and decides the erasure of every linked table', () => {
    const problems: string[] = [];
    for (const model of models) {
      const entry = DATA_INVENTORY[model.name]!;
      const columns = new Set(columnsOf(model).map((f) => f.name));
      if (entry.links === null) {
        if (entry.erasure !== null || entry.why !== null) problems.push(`${model.name}: an erasure decision without links`);
        continue;
      }
      if (entry.erasure === null || !entry.why) problems.push(`${model.name}: linked but no erasure decision and reason`);
      if (!columns.has('id')) problems.push(`${model.name}: linked tables are addressed by id`);
      for (const [kind, names] of Object.entries(entry.links) as [LinkKind, string[]][]) {
        for (const name of names) if (!columns.has(name)) problems.push(`${model.name}: ${kind} link ${name} is not a column`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('gives treatments only on pseudonymised tables, only to personal fields of a type they fit', async () => {
    // Array columns from the catalog: Prisma 7's runtime DMMF no longer says
    // `isList`, so reading it there made the list check below never fire.
    const arrays = new Set(
      (
        await prisma.$queryRaw<{ table_name: string; column_name: string }[]>`
          SELECT table_name, column_name FROM information_schema.columns
          WHERE table_schema = current_schema() AND data_type = 'ARRAY'`
      ).map((r) => `${r.table_name}.${r.column_name}`),
    );
    // The check below has teeth only while there are list columns to find.
    expect(arrays.size).toBeGreaterThan(0);
    const problems: string[] = [];
    for (const model of models) {
      const entry = DATA_INVENTORY[model.name]!;
      const types = new Map(columnsOf(model).map((f) => [f.name, f]));
      const treated = entry.fields.filter((f) => f.treatment !== null);
      if (entry.erasure === 'pseudonymize' && treated.length === 0) {
        problems.push(`${model.name}: pseudonymised but no field has a treatment`);
      }
      for (const field of treated) {
        if (entry.erasure !== 'pseudonymize') problems.push(`${model.name}.${field.name}: treatment on a ${entry.erasure ?? 'unlinked'} table`);
        if (field.class === 'none') problems.push(`${model.name}.${field.name}: treatment on a non-personal field`);
        const column = types.get(field.name)!;
        const kind = field.treatment!.kind;
        if ((kind === 'pseudonym' || kind === 'pseudonym-email' || kind === 'literal') && column.type !== 'String') {
          problems.push(`${model.name}.${field.name}: ${kind} on a ${column.type} column`);
        }
        if (kind !== 'clear' && arrays.has(`${model.name}.${field.name}`)) problems.push(`${model.name}.${field.name}: only a list can be cleared`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('marks credential material secret so an access bundle never carries it', () => {
    const secret = Object.values(DATA_INVENTORY).flatMap((e) =>
      e.fields.filter((f) => f.secret).map((f) => `${e.model}.${f.name}`),
    );
    for (const expected of [
      'PasswordCredential.hash',
      'PasswordHistory.hash',
      'Session.tokenHash',
      'RefreshToken.tokenHash',
      'RecoveryCode.codeHash',
      'WebAuthnCredential.publicKey',
      'ApiToken.tokenHash',
    ]) {
      expect(secret).toContain(expected);
    }
  });

  it('classifies the fields the privacy case turns on', () => {
    const person = new Map(DATA_INVENTORY.Person!.fields.map((f) => [f.name, f]));
    expect(person.get('givenName')?.class).toBe('identity');
    expect(person.get('personalEmail')?.class).toBe('contact');
    expect(DATA_INVENTORY.Contract!.fields.find((f) => f.name === 'jobTitle')?.class).toBe('hr');
    expect(DATA_INVENTORY.AuditEvent!.erasure).toBe('retain');
    expect(DATA_INVENTORY.PasswordCredential!.erasure).toBe('delete');
  });

  it('is rendered into docs/privacy/data-inventory.md as committed (run `pnpm privacy:inventory`)', () => {
    const path = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../docs/privacy/data-inventory.md');
    const committed = readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
    expect(committed === renderDataInventory(), 'docs/privacy/data-inventory.md is stale: run `pnpm privacy:inventory`').toBe(true);
  });
});
