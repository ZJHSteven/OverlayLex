import { readFile, writeFile } from 'node:fs/promises';

const outputPath = new URL('../dist/userscript/overlaylex.user.js', import.meta.url);
const brokenBoundary = '"use strict"(function overlayLexBootstrap';
const fixedBoundary = '"use strict";(function overlayLexBootstrap';

const source = await readFile(outputPath, 'utf8');
const brokenCount = source.split(brokenBoundary).length - 1;
const fixedCount = source.split(fixedBoundary).length - 1;

if (brokenCount === 0 && fixedCount === 1) {
  console.log('UserScript IIFE boundary is already safe.');
  process.exit(0);
}

if (brokenCount !== 1 || fixedCount !== 0) {
  throw new Error(
    `Unexpected UserScript bootstrap boundary: broken=${brokenCount}, fixed=${fixedCount}. ` +
      'Refusing to patch an unknown bundle shape.',
  );
}

await writeFile(outputPath, source.replace(brokenBoundary, fixedBoundary), 'utf8');
console.log('Patched UserScript legacy IIFE statement boundary.');
