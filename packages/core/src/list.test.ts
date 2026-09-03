import { describe, expect, it } from 'vitest';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, escapeLike, normalisePaging } from './list.js';

describe('normalisePaging', () => {
  it('defaults to the first page of the default size', () => {
    expect(normalisePaging({})).toEqual({
      page: 1,
      pageSize: DEFAULT_PAGE_SIZE,
      skip: 0,
      take: DEFAULT_PAGE_SIZE,
    });
  });

  it('turns page 0 and a negative page into page 1', () => {
    expect(normalisePaging({ page: 0 }).page).toBe(1);
    expect(normalisePaging({ page: -7 }).page).toBe(1);
    expect(normalisePaging({ page: -7 }).skip).toBe(0);
  });

  it('caps the page size at the ceiling', () => {
    const paging = normalisePaging({ pageSize: MAX_PAGE_SIZE + 1 });
    expect(paging.pageSize).toBe(MAX_PAGE_SIZE);
    expect(paging.take).toBe(MAX_PAGE_SIZE);
  });

  it('raises an empty or negative page size to one', () => {
    expect(normalisePaging({ pageSize: 0 }).pageSize).toBe(1);
    expect(normalisePaging({ pageSize: -3 }).pageSize).toBe(1);
  });

  it('treats a non-integer page as its whole part', () => {
    expect(normalisePaging({ page: 2.9, pageSize: 10 })).toEqual({
      page: 2,
      pageSize: 10,
      skip: 10,
      take: 10,
    });
  });

  it('computes skip from the clamped values, not the requested ones', () => {
    expect(normalisePaging({ page: 3, pageSize: MAX_PAGE_SIZE * 2 }).skip).toBe(
      2 * MAX_PAGE_SIZE,
    );
  });
});

describe('escapeLike', () => {
  it('escapes the wildcard characters and the escape itself', () => {
    expect(escapeLike('100%_done\\')).toBe('100\\%\\_done\\\\');
  });

  it('leaves ordinary text alone', () => {
    expect(escapeLike('Marchetti')).toBe('Marchetti');
  });
});
