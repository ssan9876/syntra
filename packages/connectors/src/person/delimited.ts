/**
 * A delimited file, parsed.
 *
 * A character-by-character scanner rather than `split`, because a delimiter
 * inside quotes and a newline inside quotes are both ordinary in an HR export
 * and `split` gets each of them wrong in a way that shifts every subsequent
 * column by one. A shifted column maps a department into a job title, and the
 * diff then proposes that as a real change on every row in the file.
 *
 * Pure, and separate from transport, so every case below is testable with a
 * string and no server -- and so a later `localFile` or `httpJson` person
 * source reuses it unchanged.
 */

export interface DelimitedOptions {
  delimiter: string;
  quoteChar: string;
  hasHeaderRow: boolean;
  /** A ceiling that throws. See `RowCeilingExceededError`. */
  maxRows: number;
}

export interface DelimitedTable {
  columns: string[];
  rows: Record<string, string>[];
}

/**
 * Thrown, never returned, and never a truncated table.
 *
 * A file that exceeded the ceiling has been read in part, and a part read that
 * a caller could mistake for a whole one is the input that departs a
 * workforce: every unread person is absent, and absence departs people.
 */
export class RowCeilingExceededError extends Error {
  constructor(readonly maxRows: number) {
    super(`the file has more than ${maxRows} rows, which is this source's limit`);
    this.name = 'RowCeilingExceededError';
  }
}

/** Splits into records, honouring quotes around delimiters and newlines. */
function scan(text: string, delimiter: string, quote: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let cell = '';
  let quoted = false;
  let i = 0;

  const endCell = () => {
    record.push(cell);
    cell = '';
  };
  const endRecord = () => {
    endCell();
    records.push(record);
    record = [];
  };

  while (i < text.length) {
    const char = text[i] as string;

    if (quoted) {
      if (char === quote) {
        // A doubled quote inside a quoted cell is one literal quote.
        if (text[i + 1] === quote) {
          cell += quote;
          i += 2;
          continue;
        }
        quoted = false;
        i += 1;
        continue;
      }
      cell += char;
      i += 1;
      continue;
    }

    if (char === quote && cell === '') {
      quoted = true;
      i += 1;
      continue;
    }
    if (char === delimiter) {
      endCell();
      i += 1;
      continue;
    }
    if (char === '\r' && text[i + 1] === '\n') {
      endRecord();
      i += 2;
      continue;
    }
    if (char === '\n' || char === '\r') {
      endRecord();
      i += 1;
      continue;
    }
    cell += char;
    i += 1;
  }

  // A file not ending in a newline still has a final record; one that does
  // ends with an empty cell that is not a record of its own.
  if (cell !== '' || record.length > 0) endRecord();

  // A blank line is not a row. This drops the trailing one, and any interior
  // ones, which an HR export routinely carries.
  return records.filter((r) => !(r.length === 1 && r[0] === ''));
}

export function readDelimited(
  text: string,
  options: DelimitedOptions,
): DelimitedTable {
  // The BOM belongs to the file, not to the first column's name. Left in
  // place it makes a mapping that names `employeeId` fail to match, and the
  // failure is invisible because the two strings print identically.
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  const records = scan(body, options.delimiter, options.quoteChar);
  if (records.length === 0) return { columns: [], rows: [] };

  const first = records[0] as string[];
  const columns = options.hasHeaderRow
    ? first.map((c) => c.trim())
    : first.map((_, index) => `column${index + 1}`);

  const seen = new Set<string>();
  for (const column of columns) {
    if (seen.has(column)) {
      throw new Error(
        `duplicate column "${column}": a mapping naming it could read either`,
      );
    }
    seen.add(column);
  }

  const dataRecords = options.hasHeaderRow ? records.slice(1) : records;
  if (dataRecords.length > options.maxRows) {
    throw new RowCeilingExceededError(options.maxRows);
  }

  const rows = dataRecords.map((record, index) => {
    if (record.length > columns.length) {
      // The line number an operator sees, counting the header.
      const line = options.hasHeaderRow ? index + 2 : index + 1;
      throw new Error(
        `row ${line} has ${record.length} cells but the header has ` +
          `${columns.length}; the extra cells name no column`,
      );
    }
    const row: Record<string, string> = {};
    columns.forEach((column, position) => {
      row[column] = record[position] ?? '';
    });
    return row;
  });

  return { columns, rows };
}
