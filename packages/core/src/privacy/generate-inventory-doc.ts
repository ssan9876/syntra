import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderDataInventory } from './inventory-doc.js';

/**
 * `pnpm privacy:inventory` writes docs/privacy/data-inventory.md from the
 * inventory in code; `--check` exits non-zero when the committed file is stale.
 */
const INVENTORY_DOC_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../docs/privacy/data-inventory.md',
);

const rendered = renderDataInventory();
if (process.argv.includes('--check')) {
  let current = '';
  try {
    current = readFileSync(INVENTORY_DOC_PATH, 'utf8').replace(/\r\n/g, '\n');
  } catch {
    // Missing counts as stale.
  }
  if (current !== rendered) {
    console.error('docs/privacy/data-inventory.md is stale: run `pnpm privacy:inventory`');
    process.exit(1);
  }
  console.log('docs/privacy/data-inventory.md is current');
} else {
  mkdirSync(dirname(INVENTORY_DOC_PATH), { recursive: true });
  writeFileSync(INVENTORY_DOC_PATH, rendered);
  console.log(`wrote ${INVENTORY_DOC_PATH}`);
}
