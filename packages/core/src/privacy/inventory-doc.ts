import {
  DATA_CATEGORIES,
  DATA_INVENTORY,
  INVENTORY_SCOPE,
  INVENTORY_PROFILES,
  type ErasureTreatment,
  type FieldEntry,
  type InventoryProfileKey,
  type SubjectLinks,
  type TableEntry,
} from './inventory.js';

/**
 * Renders the data inventory as the human-readable document committed at
 * `docs/privacy/data-inventory.md`. Deterministic: no dates, no environment,
 * so the committed file can be compared byte for byte (`inventory.test.ts`).
 */

const CATEGORY_MEANING: Record<string, string> = {
  identity: 'Who someone is: names, logins, identifiers, and references to a person or account.',
  contact: 'How to reach someone: email addresses.',
  hr: 'Employment: role, department, cost centre, manager, dates, HR identifiers.',
  authentication: 'Signing in: credentials, sessions, network addresses, browsers, factors.',
  audit: 'The tamper-evident record of actions.',
  operational: 'What the product did about or for the person: statuses, run and request records, free text typed during that work.',
};

function treatmentText(treatment: ErasureTreatment | null): string {
  if (treatment === null) return '';
  switch (treatment.kind) {
    case 'pseudonym':
      return 'pseudonym `erased-<id>`';
    case 'pseudonym-email':
      return 'pseudonym `erased-<id>@erased.invalid`';
    case 'clear':
      return 'cleared';
    case 'literal':
      return `replaced by \`${treatment.value}\``;
  }
}

function erasureCell(entry: TableEntry, field: FieldEntry): string {
  if (entry.erasure === 'delete') return 'row deleted';
  if (entry.erasure === 'retain') return 'retained';
  if (entry.erasure === 'pseudonymize') return treatmentText(field.treatment) || 'retained';
  return '';
}

function linksText(links: SubjectLinks): string {
  return Object.entries(links)
    .map(([kind, columns]) => `${kind}: ${(columns as string[]).map((c) => `\`${c}\``).join(', ')}`)
    .join('; ');
}

function escapeCell(text: string): string {
  return text.replace(/\|/g, '\\|');
}

export function renderDataInventory(): string {
  const lines: string[] = [];
  const push = (...more: string[]) => lines.push(...more);
  const tables = Object.values(DATA_INVENTORY);

  push(
    '# Syntra data inventory',
    '',
    '<!-- Generated from packages/core/src/privacy/inventory.ts by `pnpm privacy:inventory`. Do not edit by hand: a test fails when this file and the inventory disagree. -->',
    '',
    'Every column of every table Syntra stores, classified by personal-data category, with the purpose, source, retention and access of each area, and exactly what a data-subject erasure does to each column. The inventory in code is the source of truth; the data-subject search, the access bundle and the erasure all read it, so this document describes what they actually do.',
    '',
    '**Legal bases are placeholders.** The controller decides them; each area states what is typical so a privacy reviewer has something to confirm or replace.',
    '',
    '## Scope',
    '',
    `- **Controller.** ${INVENTORY_SCOPE.controller}`,
    `- **Residency.** ${INVENTORY_SCOPE.residency}`,
    `- **Processors.** ${INVENTORY_SCOPE.processors}`,
    '',
    '## Categories',
    '',
    '| Category | Meaning |',
    '| --- | --- |',
    ...DATA_CATEGORIES.map((c) => `| \`${c}\` | ${CATEGORY_MEANING[c]} |`),
    '| `none` | Not personal data. |',
    '',
    'A column marked **secret** is credential material and is never copied into an access bundle.',
    '',
    '## Data-subject erasure at a glance',
    '',
    'An erasure finds rows through each table\'s *subject links* and then, per table, pseudonymises named columns in place, deletes the rows (credential and transient state only), or retains them for the reason given. See [Operate, Data-subject requests](../operate.md#data-subject-requests) for the procedure and its preconditions.',
    '',
    '| Table | Linked by | Erasure | Why |',
    '| --- | --- | --- | --- |',
  );
  for (const entry of [...tables].filter((t) => t.links !== null).sort((a, b) => a.model.localeCompare(b.model))) {
    push(`| \`${entry.model}\` | ${linksText(entry.links!)} | ${entry.erasure} | ${escapeCell(entry.why ?? '')} |`);
  }
  push('');

  push('## Tables by area', '');
  for (const key of Object.keys(INVENTORY_PROFILES) as InventoryProfileKey[]) {
    const profile = INVENTORY_PROFILES[key];
    const members = tables.filter((t) => t.profile === key).sort((a, b) => a.model.localeCompare(b.model));
    if (members.length === 0) continue;
    push(
      `### ${profile.title}`,
      '',
      `- **Purpose.** ${profile.purpose}`,
      `- **Source.** ${profile.source}`,
      `- **Retention.** ${profile.retention}`,
      `- **Legal basis.** ${profile.legalBasis}`,
      `- **Access.** ${profile.access}`,
      '',
    );
    for (const entry of members) {
      const personal = entry.fields.filter((f) => f.class !== 'none');
      const other = entry.fields.filter((f) => f.class === 'none');
      push(`#### \`${entry.model}\``, '');
      if (personal.length === 0) {
        push(`No personal data. Columns: ${other.map((f) => `\`${f.name}\``).join(', ')}.`, '');
        continue;
      }
      if (entry.links !== null) {
        push(`Linked to a data subject by ${linksText(entry.links)}. Erasure: **${entry.erasure}** -- ${entry.why}`, '');
      }
      push('| Column | Category | Erasure | Notes |', '| --- | --- | --- | --- |');
      for (const field of personal) {
        push(`| \`${field.name}\` | ${field.class} | ${erasureCell(entry, field)} | ${field.secret ? 'secret' : ''} |`);
      }
      push('');
      if (other.length > 0) push(`Not personal data: ${other.map((f) => `\`${f.name}\``).join(', ')}.`, '');
    }
  }
  return `${lines.join('\n').trimEnd()}\n`;
}
