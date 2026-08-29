import { describe, expect, it } from 'vitest';
import { createSourceRequest, updateSourceRequest } from './sync.js';
import {
  createPersonSourceRequest,
  updatePersonSourceRequest,
} from './person-source.js';
import { tenantSettingsRequest } from './tenant.js';
import { patchUserRequest } from './reset.js';

/**
 * The schemas carrying a security-relevant flag refuse a key they do not know.
 *
 * `provision.ts` writes the argument out at length for target configuration and
 * these four never got it. The failure is quiet and specific: zod strips an
 * unknown key, so a PATCH carrying `writebackPasword` alongside a valid field
 * commits the valid one, answers success, and leaves password write-back
 * exactly as it was. An administrator narrowing a source's behaviour after an
 * incident gets a save that reports success and changed nothing.
 *
 * Note for anyone editing these: `.partial()` and `.extend()` PRESERVE
 * `unknownKeys` in zod, so a derived schema is still strict. `.passthrough()`
 * is what reverses it.
 */
describe('the schemas that carry a security-relevant flag are strict', () => {
  it('refuses a misspelled write-back flag on a source update', () => {
    const result = updateSourceRequest.safeParse({
      name: 'AD',
      writebackPasword: true,
    });
    expect(result.success).toBe(false);
  });

  it('refuses one on a source create', () => {
    const result = createSourceRequest.safeParse({
      name: 'AD',
      config: {},
      bindPassword: 'x',
      writebackDisble: true,
    });
    expect(result.success).toBe(false);
  });

  /**
   * `adminMfaRequired` is what decides whether the console demands a second
   * factor. A misspelling that turned into a 200 and no change is an operator
   * who believes they hardened the console and did not.
   */
  it('refuses a misspelled tenant setting', () => {
    const result = tenantSettingsRequest.safeParse({ adminMfaRequred: true });
    expect(result.success).toBe(false);
  });

  /**
   * `passwordSource` decides whether Syntra holds this account's password at
   * all. There is nothing here that should be stripped silently.
   */
  it('refuses a misspelled password-source field', () => {
    const result = patchUserRequest.safeParse({ passwordSorce: 'upstream' });
    expect(result.success).toBe(false);
  });

  it('still accepts every field each schema actually declares', () => {
    expect(
      updateSourceRequest.safeParse({
        name: 'AD',
        writebackEnabled: true,
        writebackPassword: true,
        writebackDisable: false,
      }).success,
    ).toBe(true);
    expect(tenantSettingsRequest.safeParse({ adminMfaRequired: true }).success).toBe(true);
    expect(patchUserRequest.safeParse({ passwordSource: 'upstream' }).success).toBe(true);
  });
});

/**
 * `feedMode` is the most dangerous field in the product: a delta file read as
 * a snapshot departs everyone who did not change yesterday. There is no
 * default in the schema, the migration, the service or the form, and these
 * assert there is none at the outermost edge either.
 */
describe('a person source request refuses what it does not know', () => {
  it('refuses a misspelled feed mode key', () => {
    const result = updatePersonSourceRequest.safeParse({ feedMod: 'delta' });
    expect(result.success).toBe(false);
  });

  it('refuses a create with no feed mode at all', () => {
    const result = createPersonSourceRequest.safeParse({
      name: 'HR',
      type: 'sftpDelimited',
      config: {},
      credential: 'x',
    });
    expect(result.success).toBe(false);
  });

  it('refuses a feed mode that is neither snapshot nor delta', () => {
    const result = createPersonSourceRequest.safeParse({
      name: 'HR',
      type: 'sftpDelimited',
      feedMode: 'incremental',
      config: {},
      credential: 'x',
    });
    expect(result.success).toBe(false);
  });

  it('accepts a create that names one', () => {
    const result = createPersonSourceRequest.safeParse({
      name: 'HR',
      type: 'sftpDelimited',
      feedMode: 'snapshot',
      config: { host: 'hr.test' },
      credential: 'x',
    });
    expect(result.success).toBe(true);
  });
});
