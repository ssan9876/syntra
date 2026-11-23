import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { SCHEMA_PATH, renderedSchema } from './generate-schema.js';

describe('protocol.schema.json', () => {
  it('is the schema the code validates against. Regenerate with `pnpm --filter @syntra/connector-sdk schema:generate`', async () => {
    const committed = (await readFile(SCHEMA_PATH, 'utf8')).replace(/\r\n/g, '\n');
    expect(committed).toBe(renderedSchema());
  });
});
