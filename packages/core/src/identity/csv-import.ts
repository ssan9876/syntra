import type { TenantClient } from '@syntra/db';
import { currentTenant } from '../tenant-context.js';

export interface PersonCsvRow {
  externalId: string;
  givenName: string;
  familyName: string;
  businessEmail?: string;
  contract: {
    sequence: number;
    isPrimary: boolean;
    startDate: Date;
    endDate?: Date;
    jobTitle?: string;
    department?: string;
  };
}

export interface CsvError {
  line: number;
  message: string;
}

const REQUIRED = [
  'externalId',
  'givenName',
  'familyName',
  'sequence',
  'startDate',
] as const;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Rejects both malformed strings and impossible days. Date.parse accepts
 * 2026-02-30 and silently rolls it forward to March, which would put a
 * contract's start date in the wrong month without any error.
 */
function parseIsoDate(value: string): Date | null {
  if (!ISO_DATE.test(value)) return null;
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return null;
  if (date.toISOString().slice(0, 10) !== value) return null;
  return date;
}

type SplitResult = { cells: string[] } | { error: string };

/**
 * An RFC 4180 tokenizer for one physical line: a double-quoted field may
 * contain commas and a `""`-escaped quote, and only an unquoted cell is
 * trimmed. Lines are split on `\r?\n` before this runs (see `parsePersonCsv`
 * below), so a quoted field that legitimately spans multiple lines is not
 * reassembled — it is simpler, and safer for an operator to see, to report an
 * unterminated quote on that line than to silently re-join input across line
 * boundaries.
 */
function splitLine(line: string): SplitResult {
  const cells: string[] = [];
  let cur = '';
  let inQuotes = false;
  let quotedField = false;
  const n = line.length;

  for (let i = 0; i < n; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
          continue;
        }
        inQuotes = false;
        continue;
      }
      cur += ch;
      continue;
    }
    if (ch === '"' && cur === '') {
      inQuotes = true;
      quotedField = true;
      continue;
    }
    if (ch === ',') {
      cells.push(quotedField ? cur : cur.trim());
      cur = '';
      quotedField = false;
      continue;
    }
    cur += ch;
  }

  if (inQuotes) return { error: 'unterminated quoted field' };
  cells.push(quotedField ? cur : cur.trim());
  return { cells };
}

/**
 * Parses without throwing. Every problem is reported against its line number,
 * and valid rows are returned alongside the errors, so a caller can import
 * what is good and show the operator precisely what was not.
 */
export function parsePersonCsv(text: string): {
  rows: PersonCsvRow[];
  errors: CsvError[];
} {
  const rows: PersonCsvRow[] = [];
  const errors: CsvError[] = [];

  const trimmed = text.trim();
  if (trimmed === '') {
    return { rows, errors: [{ line: 1, message: 'file is empty' }] };
  }

  const lines = trimmed.split(/\r?\n/);
  const headerSplit = splitLine(lines[0]!);
  if ('error' in headerSplit) {
    return { rows, errors: [{ line: 1, message: headerSplit.error }] };
  }
  const header = headerSplit.cells;

  for (const column of REQUIRED) {
    if (!header.includes(column)) {
      errors.push({ line: 1, message: `missing column: ${column}` });
    }
  }
  if (errors.length > 0) return { rows, errors };

  const at = (cells: string[], name: string): string | undefined => {
    const index = header.indexOf(name);
    if (index === -1) return undefined;
    const value = cells[index];
    return value === '' || value === undefined ? undefined : value;
  };

  for (let i = 1; i < lines.length; i++) {
    const lineNumber = i + 1;
    const raw = lines[i]!;
    if (raw.trim() === '') continue;

    const rowSplit = splitLine(raw);
    if ('error' in rowSplit) {
      errors.push({ line: lineNumber, message: rowSplit.error });
      continue;
    }
    const cells = rowSplit.cells;

    const startRaw = at(cells, 'startDate');
    const startDate = startRaw ? parseIsoDate(startRaw) : null;
    if (!startDate) {
      errors.push({
        line: lineNumber,
        message: 'startDate is not a valid ISO date',
      });
      continue;
    }

    const endRaw = at(cells, 'endDate');
    let endDate: Date | undefined;
    if (endRaw) {
      const parsed = parseIsoDate(endRaw);
      if (!parsed) {
        errors.push({
          line: lineNumber,
          message: 'endDate is not a valid ISO date',
        });
        continue;
      }
      endDate = parsed;
    }

    const sequenceRaw = at(cells, 'sequence');
    const sequence = Number(sequenceRaw);
    if (!sequenceRaw || !Number.isInteger(sequence)) {
      errors.push({ line: lineNumber, message: 'sequence is not an integer' });
      continue;
    }

    const externalId = at(cells, 'externalId');
    const givenName = at(cells, 'givenName');
    const familyName = at(cells, 'familyName');
    if (!externalId || !givenName || !familyName) {
      errors.push({
        line: lineNumber,
        message: 'externalId, givenName and familyName are required',
      });
      continue;
    }

    const businessEmail = at(cells, 'businessEmail');
    const jobTitle = at(cells, 'jobTitle');
    const department = at(cells, 'department');

    rows.push({
      externalId,
      givenName,
      familyName,
      ...(businessEmail ? { businessEmail } : {}),
      contract: {
        sequence,
        isPrimary: at(cells, 'isPrimary')?.toLowerCase() === 'true',
        startDate,
        ...(endDate ? { endDate } : {}),
        ...(jobTitle ? { jobTitle } : {}),
        ...(department ? { department } : {}),
      },
    });
  }

  return { rows, errors };
}

/**
 * Upserts people by external identifier and their contracts by sequence
 * number, so re-importing the same file changes nothing and re-importing a
 * corrected one updates in place rather than accumulating duplicates.
 */
export async function importPersons(
  tx: TenantClient,
  rows: PersonCsvRow[],
): Promise<{ created: number; updated: number }> {
  const tenantId = await currentTenant(tx);
  let created = 0;
  let updated = 0;

  for (const row of rows) {
    const existing = await tx.person.findFirst({
      where: { externalId: row.externalId },
    });

    const person = existing
      ? await tx.person.update({
          where: { id: existing.id },
          data: {
            givenName: row.givenName,
            familyName: row.familyName,
            businessEmail: row.businessEmail ?? null,
          },
        })
      : await tx.person.create({
          data: {
            tenantId,
            externalId: row.externalId,
            givenName: row.givenName,
            familyName: row.familyName,
            businessEmail: row.businessEmail ?? null,
          },
        });

    if (existing) updated++;
    else created++;

    const contract = await tx.contract.findFirst({
      where: { personId: person.id, sequence: row.contract.sequence },
    });

    const data = {
      isPrimary: row.contract.isPrimary,
      startDate: row.contract.startDate,
      endDate: row.contract.endDate ?? null,
      jobTitle: row.contract.jobTitle ?? null,
      department: row.contract.department ?? null,
    };

    if (contract) {
      await tx.contract.update({ where: { id: contract.id }, data });
    } else {
      await tx.contract.create({
        data: {
          tenantId,
          personId: person.id,
          sequence: row.contract.sequence,
          ...data,
        },
      });
    }
  }

  return { created, updated };
}
