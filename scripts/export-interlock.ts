/** Run with node --import tsx scripts/export-interlock.ts [sharp module path]. */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CONSOLE_ICONS, INTERLOCK_MARK } from '../apps/web/src/branding/interlock.js';
import { BUILTIN_APP_ICONS } from '../packages/contracts/src/app-icon-keys.js';

const sharpModule = process.argv[2] ?? 'sharp';
const { default: sharp } = await import(isAbsolute(sharpModule) ? pathToFileURL(sharpModule).href : sharpModule);
const publicRoot = resolve('apps/web/public');
const colors = { blue: '#16588E', orange: '#C24D0C', ink: '#102B46' };
const wrap = (body: string, size: number, width = size) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${size}" width="${width}" height="${size}">${body}</svg>\n`;
const mark = `<g fill="none" stroke-width="7" stroke-linecap="round"><path d="${INTERLOCK_MARK.orange}" stroke="${colors.orange}"/><path d="${INTERLOCK_MARK.blue}" stroke="${colors.blue}"/></g>`;
async function output(relative: string, svg: string, pixels: number) {
  const path = resolve(publicRoot, relative);
  await mkdir(resolve(path, '..'), { recursive: true });
  await writeFile(`${path}.svg`, svg);
  await sharp(Buffer.from(svg)).resize({ width: pixels }).webp({ lossless: true }).toFile(`${path}.webp`);
}
await output('brand/syntra-mark', wrap(mark, 40), 512);
await output('brand/syntra-logo', wrap(`${mark}<text x="49" y="29" font-family="Segoe UI, sans-serif" font-size="29" font-weight="650" letter-spacing="-.8" fill="${colors.ink}">Syntra</text>`, 40, 148), 1184);
for (const [name, glyph] of Object.entries(CONSOLE_ICONS)) {
  await output(`brand/icons/${name}`, wrap(`<g fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="${glyph.outline}" stroke="${colors.blue}"/><path d="${glyph.detail}" stroke="${colors.orange}"/></g>`, 24), 192);
}
const applicationGlyphs = JSON.parse(await readFile(resolve('apps/web/src/branding/application-glyphs.json'), 'utf8')) as Record<string, string[]>;
for (const key of BUILTIN_APP_ICONS) {
  const elements = applicationGlyphs[key]!;
  const main = elements.slice(0, -1).join('');
  const detail = elements.at(-1);
  const svg = wrap(`<rect x=".5" y=".5" width="47" height="47" rx="11" fill="#F6F9FC" stroke="#DFE7EE"/><g fill="none" stroke="${colors.blue}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">${main}<g stroke="${colors.orange}">${detail}</g></g>`, 48);
  await output(`app-icons/${key}`, svg, 192);
}
console.log('Exported Interlock: logo, mark, 19 navigation icons, 20 application icons (SVG + lossless WebP).');
