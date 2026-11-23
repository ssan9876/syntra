/**
 * `pnpm --filter @syntra/connector-sdk schema:generate` writes
 * `protocol.schema.json`; `schema:check` fails when it is out of date. The
 * test suite runs the same comparison.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { protocolJsonSchema } from './json-schema.js';

export const SCHEMA_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '../protocol.schema.json');

export function renderedSchema(): string {
  return `${JSON.stringify(protocolJsonSchema(), null, 2)}\n`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const rendered = renderedSchema();
  if (process.argv.includes('--check')) {
    const committed = await readFile(SCHEMA_PATH, 'utf8').catch(() => '');
    if (committed.replace(/\r\n/g, '\n') !== rendered) {
      console.error(`${SCHEMA_PATH} is out of date. Run \`pnpm --filter @syntra/connector-sdk schema:generate\`.`);
      process.exitCode = 1;
    } else {
      console.log(`${SCHEMA_PATH} is up to date.`);
    }
  } else {
    await writeFile(SCHEMA_PATH, rendered);
    console.log(`Wrote ${SCHEMA_PATH}`);
  }
}
