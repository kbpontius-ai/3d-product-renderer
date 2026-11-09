import { describe, expect, it } from 'vitest';
import { currentPage, listQuery } from './admin-list';

describe('admin list query boundaries', () => {
  it('normalizes malformed URL values without allowing unbounded offsets', () => {
    expect(
      listQuery.parse({ q: ['first', 'second'], role: 'admin', status: 'expired', page: '-2' }),
    ).toEqual({ q: '', page: 1 });
    for (const page of ['Infinity', '100001', '1.5', ['2', '3']]) {
      expect(listQuery.parse({ page }).page).toBe(1);
    }
  });
  it('retains valid scoped filters and clamps a stale page after deletion', () => {
    expect(
      listQuery.parse({ q: '  logo@example.com ', role: 'owner', status: 'invited', page: '5' }),
    ).toEqual({ q: 'logo@example.com', role: 'owner', status: 'invited', page: 5 });
    expect(currentPage(5, 201)).toBe(5);
    expect(currentPage(5, 200)).toBe(4);
    expect(currentPage(5, 0)).toBe(1);
  });
});
