import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { importPersons, parsePersonCsv } from './csv-import.js';

const HEADER =
  'externalId,givenName,familyName,businessEmail,sequence,isPrimary,startDate,endDate,jobTitle,department';

let tenantId: string;

beforeEach(async () => {
  await resetDatabase();
  const t = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  tenantId = t.id;
});

describe('parsePersonCsv', () => {
  it('parses a well-formed row', () => {
    const { rows, errors } = parsePersonCsv(
      `${HEADER}\nE1,Jo,Doe,jo@acme.test,1,true,2026-01-01,,Nurse,Care`,
    );
    expect(errors).toEqual([]);
    expect(rows[0]).toMatchObject({
      externalId: 'E1',
      givenName: 'Jo',
      familyName: 'Doe',
      contract: {
        sequence: 1,
        isPrimary: true,
        jobTitle: 'Nurse',
        department: 'Care',
      },
    });
    expect(rows[0]!.contract.endDate).toBeUndefined();
  });

  it('reports the line number of a bad date instead of throwing', () => {
    const { rows, errors } = parsePersonCsv(
      `${HEADER}\nE1,Jo,Doe,jo@acme.test,1,true,not-a-date,,Nurse,Care`,
    );
    expect(rows).toEqual([]);
    expect(errors).toEqual([
      { line: 2, message: 'startDate is not a valid ISO date' },
    ]);
  });

  it('rejects a date that looks valid but is not a real day', () => {
    const { errors } = parsePersonCsv(
      `${HEADER}\nE1,Jo,Doe,jo@acme.test,1,true,2026-02-30,,Nurse,Care`,
    );
    expect(errors).toEqual([
      { line: 2, message: 'startDate is not a valid ISO date' },
    ]);
  });

  it('reports a missing required column', () => {
    const { errors } = parsePersonCsv('givenName,familyName\nJo,Doe');
    expect(errors[0]!.message).toMatch(/missing column: externalId/i);
  });

  it('keeps good rows and reports bad ones together', () => {
    const { rows, errors } = parsePersonCsv(
      `${HEADER}\nE1,Jo,Doe,jo@acme.test,1,true,2026-01-01,,Nurse,Care\n` +
        `E2,Sam,Roe,sam@acme.test,x,false,2026-01-01,,Trainer,Care`,
    );
    expect(rows).toHaveLength(1);
    expect(errors).toEqual([
      { line: 3, message: 'sequence is not an integer' },
    ]);
  });

  it('keeps a comma inside a quoted field as part of the value', () => {
    const { rows, errors } = parsePersonCsv(
      `${HEADER}\nE1,Jo,Doe,jo@acme.test,1,true,2026-01-01,,Nurse,"Care, Emergency"`,
    );
    expect(errors).toEqual([]);
    expect(rows[0]!.contract.department).toBe('Care, Emergency');
  });

  it('unescapes a doubled quote inside a quoted field', () => {
    const { rows, errors } = parsePersonCsv(
      `${HEADER}\nE1,Jo,"O""Doe",jo@acme.test,1,true,2026-01-01,,Nurse,Care`,
    );
    expect(errors).toEqual([]);
    expect(rows[0]!.familyName).toBe('O"Doe');
  });

  it('reports an unterminated quote against its line rather than throwing', () => {
    const { rows, errors } = parsePersonCsv(
      `${HEADER}\nE1,Jo,"Doe,jo@acme.test,1,true,2026-01-01,,Nurse,Care`,
    );
    expect(rows).toEqual([]);
    expect(errors).toEqual([{ line: 2, message: 'unterminated quoted field' }]);
  });

  it('reports an empty file rather than returning nothing silently', () => {
    const { errors } = parsePersonCsv('   ');
    expect(errors[0]!.message).toMatch(/empty/i);
  });

  it('ignores a trailing blank line', () => {
    const { rows, errors } = parsePersonCsv(
      `${HEADER}\nE1,Jo,Doe,jo@acme.test,1,true,2026-01-01,,Nurse,Care\n\n`,
    );
    expect(rows).toHaveLength(1);
    expect(errors).toEqual([]);
  });

  it('treats a missing end date as open-ended', () => {
    const { rows } = parsePersonCsv(
      `${HEADER}\nE1,Jo,Doe,jo@acme.test,1,false,2026-01-01,,Nurse,Care`,
    );
    expect(rows[0]!.contract.endDate).toBeUndefined();
  });
});

describe('importPersons', () => {
  const parse = (csv: string) => parsePersonCsv(csv).rows;

  it('creates a person with their contract', async () => {
    const rows = parse(
      `${HEADER}\nE1,Jo,Doe,jo@acme.test,1,true,2026-01-01,,Nurse,Care`,
    );
    const result = await withTenant(tenantId, (tx) => importPersons(tx, rows));
    expect(result).toEqual({ created: 1, updated: 0 });

    const persons = await withTenant(tenantId, (tx) => tx.person.findMany());
    const contracts = await withTenant(tenantId, (tx) =>
      tx.contract.findMany(),
    );
    expect(persons).toHaveLength(1);
    expect(contracts[0]!.jobTitle).toBe('Nurse');
  });

  it('is idempotent on externalId', async () => {
    const csv = `${HEADER}\nE1,Jo,Doe,jo@acme.test,1,true,2026-01-01,,Nurse,Care`;
    await withTenant(tenantId, (tx) => importPersons(tx, parse(csv)));
    const second = await withTenant(tenantId, (tx) =>
      importPersons(tx, parse(csv)),
    );

    expect(second).toEqual({ created: 0, updated: 1 });
    expect(
      await withTenant(tenantId, (tx) => tx.person.count()),
    ).toBe(1);
    expect(
      await withTenant(tenantId, (tx) => tx.contract.count()),
    ).toBe(1);
  });

  it('adds a second contract for a person who gains one', async () => {
    await withTenant(tenantId, (tx) =>
      importPersons(
        tx,
        parse(
          `${HEADER}\nE1,Jo,Doe,jo@acme.test,1,true,2026-01-01,,Nurse,Care`,
        ),
      ),
    );
    await withTenant(tenantId, (tx) =>
      importPersons(
        tx,
        parse(
          `${HEADER}\nE1,Jo,Doe,jo@acme.test,2,false,2026-03-01,,Trainer,Learning`,
        ),
      ),
    );

    expect(await withTenant(tenantId, (tx) => tx.contract.count())).toBe(2);
    expect(await withTenant(tenantId, (tx) => tx.person.count())).toBe(1);
  });

  it('updates a changed job title in place on re-import', async () => {
    await withTenant(tenantId, (tx) =>
      importPersons(
        tx,
        parse(
          `${HEADER}\nE1,Jo,Doe,jo@acme.test,1,true,2026-01-01,,Nurse,Care`,
        ),
      ),
    );
    await withTenant(tenantId, (tx) =>
      importPersons(
        tx,
        parse(
          `${HEADER}\nE1,Jo,Doe,jo@acme.test,1,true,2026-01-01,,Senior Nurse,Care`,
        ),
      ),
    );

    const contracts = await withTenant(tenantId, (tx) =>
      tx.contract.findMany(),
    );
    expect(contracts).toHaveLength(1);
    expect(contracts[0]!.jobTitle).toBe('Senior Nurse');
  });

  it('records an end date arriving on a later import', async () => {
    await withTenant(tenantId, (tx) =>
      importPersons(
        tx,
        parse(
          `${HEADER}\nE1,Jo,Doe,jo@acme.test,1,true,2026-01-01,,Nurse,Care`,
        ),
      ),
    );
    await withTenant(tenantId, (tx) =>
      importPersons(
        tx,
        parse(
          `${HEADER}\nE1,Jo,Doe,jo@acme.test,1,true,2026-01-01,2026-09-30,Nurse,Care`,
        ),
      ),
    );

    const contract = await withTenant(tenantId, (tx) => tx.contract.findFirst());
    expect(contract!.endDate).not.toBeNull();
  });

  it('imports two people in one pass', async () => {
    const rows = parse(
      `${HEADER}\nE1,Jo,Doe,jo@acme.test,1,true,2026-01-01,,Nurse,Care\n` +
        `E2,Sam,Roe,sam@acme.test,1,true,2026-01-01,,Trainer,Learning`,
    );
    const result = await withTenant(tenantId, (tx) => importPersons(tx, rows));
    expect(result).toEqual({ created: 2, updated: 0 });
  });
});
