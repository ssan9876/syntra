import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The console does not explain itself in prose.
 *
 * A hundred and forty explanatory strings were removed: fifty-five page
 * descriptions, thirty-four panel descriptions, and eighty-nine field hints.
 * Read together they were an argument against themselves — several existed
 * only to explain a split in the navigation, several restated the title in a
 * longer sentence, and most described what the control underneath already
 * showed. Seven carried something real, and those became `warning` (a state,
 * shown only while it applies), `placeholder` (in the control, where somebody
 * about to type is looking) or `PageFacts` (a value, labelled as a value).
 *
 * This is asserted rather than reviewed because the pressure that produced
 * those hundred and forty has not gone anywhere. Every new screen has a moment
 * where a sentence is the quickest way to make it make sense, and the
 * quickest way is what a reviewer under time pressure approves. The props are
 * gone from the components, so TypeScript catches most of it; this catches a
 * page that reintroduces one locally, which is exactly how the last local
 * `Toggle` with a mandatory `hint` came to exist.
 */

const DIRS = ['src/pages/admin', 'src/pages', 'src/components'];

function sources(): { name: string; text: string }[] {
  const out: { name: string; text: string }[] = [];
  for (const dir of DIRS) {
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.tsx') || file.includes('.test.')) continue;
      out.push({ name: `${dir}/${file}`, text: readFileSync(`${dir}/${file}`, 'utf8') });
    }
  }
  return out;
}

describe('no prose in the console', () => {
  it('passes no description to a page header or a panel', () => {
    const offenders = sources()
      .filter((f) => /\bdescription=/.test(f.text))
      .map((f) => f.name);
    expect(offenders).toEqual([]);
  });

  it('passes no hint to any control', () => {
    // `warning` replaced it. The difference is not the name: a hint is
    // permanent and a warning is conditional, and a `warning` that is always
    // on is a hint wearing a warning's colour.
    const offenders = sources()
      .filter((f) => /\bhint=/.test(f.text))
      .map((f) => f.name);
    expect(offenders).toEqual([]);
  });

  it('declares no local component with a hint or description PROP', () => {
    // How the last one got in: a `Toggle` in the tenant settings page that
    // was `Check` plus a REQUIRED hint, so every use of it had to write a
    // sentence whether or not there was one to write.
    //
    // `description` on its own is not the offence, and an earlier version of
    // this test said it was — it flagged fifteen files, every one of them a
    // DATA row. A Group has a description, so does a Role and a catalog
    // product; those are things a user typed and the console stores, and a
    // rule that forbade them would have been a rule against the domain rather
    // than against prose.
    //
    // The distinction that matters is what the field sits NEXT TO. A
    // `description` beside a `label` or a `title` is a caption on a control.
    // A `description` beside an `id` is a column.
    const offenders: string[] = [];
    for (const file of sources()) {
      // `hint` is never domain data in this product.
      if (/^\s*hint\??:\s/m.test(file.text)) offenders.push(`${file.name} (hint)`);

      // Only PROP types. `Action { key, label, description, inputs }` in the
      // delegated-tasks screen looks identical to a caption and is neither —
      // it is the shape of a row the API returns, and its description is
      // something an administrator typed and the server stored. A rule that
      // could not tell those apart would be a rule against the domain.
      for (const block of file.text.split(/interface\s/).slice(1)) {
        const name = block.slice(0, block.search(/[\s{]/));
        if (!name.endsWith('Props')) continue;
        const body = block.slice(0, block.indexOf('}') + 1);
        if (/^\s*description\??:\s/m.test(body)) {
          offenders.push(`${file.name} (${name}.description)`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('the components that carried the prose', () => {
  const read = (p: string) => readFileSync(p, 'utf8');

  it('PageHeader accepts a title and actions, and nothing else', () => {
    const text = read('src/pages/admin/PageHeader.tsx');
    expect(text).not.toMatch(/description\??:/);
  });

  it('Panel accepts no description', () => {
    expect(read('../../packages/ui/src/Panel.tsx')).not.toMatch(/description\??:/);
  });

  it('Field and Check offer a warning instead of a hint', () => {
    for (const p of ['../../packages/ui/src/Field.tsx', '../../packages/ui/src/Check.tsx']) {
      const text = read(p);
      expect(text).not.toMatch(/\bhint\??:/);
      expect(text).toMatch(/warning\?:/);
    }
  });

  it('keeps the warning wired to aria-describedby', () => {
    // The point of removing prose was that nobody read it. Screen-reader
    // users were the exception — `hint` was their description — so a
    // replacement that dropped the association would have taken information
    // away from the one audience that had it.
    for (const p of ['../../packages/ui/src/Field.tsx', '../../packages/ui/src/Check.tsx']) {
      expect(read(p)).toMatch(/aria-describedby/);
    }
  });
});
