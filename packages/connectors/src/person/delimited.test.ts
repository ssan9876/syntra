import { describe, expect, it } from 'vitest';
import { RowCeilingExceededError, readDelimited } from './delimited.js';

const options = { delimiter: ',', quoteChar: '"', hasHeaderRow: true, maxRows: 1000 };

describe('readDelimited', () => {
  it('reads a header and one row', () => {
    const table = readDelimited('id,name\n1,Ada', options);
    expect(table.columns).toEqual(['id', 'name']);
    expect(table.rows).toEqual([{ id: '1', name: 'Ada' }]);
  });

  it('keeps a delimiter that sits inside quotes', () => {
    const table = readDelimited('id,name\n1,"Lovelace, Ada"', options);
    expect(table.rows[0]?.name).toBe('Lovelace, Ada');
  });

  it('keeps a newline that sits inside quotes', () => {
    const table = readDelimited('id,note\n1,"two\nlines"', options);
    expect(table.rows).toHaveLength(1);
    expect(table.rows[0]?.note).toBe('two\nlines');
  });

  it('reads a doubled quote as one literal quote', () => {
    const table = readDelimited('id,name\n1,"a ""b"" c"', options);
    expect(table.rows[0]?.name).toBe('a "b" c');
  });

  it('strips a UTF-8 BOM from the first column name', () => {
    const table = readDelimited('﻿id,name\n1,Ada', options);
    expect(table.columns).toEqual(['id', 'name']);
  });

  it('reads CRLF line endings', () => {
    const table = readDelimited('id,name\r\n1,Ada\r\n', options);
    expect(table.rows).toEqual([{ id: '1', name: 'Ada' }]);
  });

  it('ignores a trailing blank line', () => {
    const table = readDelimited('id,name\n1,Ada\n\n', options);
    expect(table.rows).toHaveLength(1);
  });

  /**
   * A short row is padded rather than rejected. An HR export that omits
   * trailing empty cells is ordinary, and rejecting it would fail the whole
   * run over formatting rather than content.
   */
  it('pads a row with fewer cells than the header', () => {
    const table = readDelimited('id,name,dept\n1,Ada', options);
    expect(table.rows[0]).toEqual({ id: '1', name: 'Ada', dept: '' });
  });

  /**
   * A long row is NOT padded away -- the extra cells have no column name, so
   * silently dropping them loses data the file carried and nobody is told.
   */
  it('refuses a row with more cells than the header', () => {
    expect(() => readDelimited('id,name\n1,Ada,extra', options)).toThrow(
      /row 2 has 3 cells but the header has 2/,
    );
  });

  it('refuses a duplicate column name', () => {
    expect(() => readDelimited('id,id\n1,2', options)).toThrow(/duplicate column "id"/);
  });

  /**
   * The empty file reaches the run as zero rows, and the run blocks on
   * recordsRead === 0. This is the one case the parser must not smooth over:
   * an empty file and an unreachable server are indistinguishable, and the
   * safe reading is the second.
   */
  it('returns no rows for an empty file rather than throwing', () => {
    expect(readDelimited('', options)).toEqual({ columns: [], rows: [] });
  });

  it('returns no rows for a header with no data rows', () => {
    const table = readDelimited('id,name\n', options);
    expect(table.columns).toEqual(['id', 'name']);
    expect(table.rows).toEqual([]);
  });

  it('names columns positionally when there is no header row', () => {
    const table = readDelimited('1,Ada', { ...options, hasHeaderRow: false });
    expect(table.columns).toEqual(['column1', 'column2']);
    expect(table.rows[0]).toEqual({ column1: '1', column2: 'Ada' });
  });

  it('throws rather than truncating when the row ceiling is reached', () => {
    const text = ['id', '1', '2', '3'].join('\n');
    expect(() => readDelimited(text, { ...options, maxRows: 2 })).toThrow(
      RowCeilingExceededError,
    );
  });

  it('honours a tab delimiter', () => {
    const table = readDelimited('id\tname\n1\tAda', { ...options, delimiter: '\t' });
    expect(table.rows[0]).toEqual({ id: '1', name: 'Ada' });
  });
});
