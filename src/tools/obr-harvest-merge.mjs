#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

function parseArgs(argv) {
  const out = { staticDir: null, mockDir: null, existing: null, outDir: '.harvest/merged' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--static') out.staticDir = argv[++i];
    else if (argv[i] === '--mock') out.mockDir = argv[++i];
    else if (argv[i] === '--existing') out.existing = argv[++i];
    else if (argv[i] === '--out') out.outDir = argv[++i];
    else if (argv[i] === '--help' || argv[i] === '-h') out.help = true;
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  return out;
}

function usage() {
  return 'Usage: node src/tools/obr-harvest-merge.mjs --static <dir> --mock <dir> --existing <package.json> --out <dir>';
}

function normalize(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function isCandidate(text) {
  if (!text || text.length < 2 || text.length > 500 || !/[A-Za-z]/.test(text)) return false;
  if (/^(?:https?:|data:|blob:|mailto:)/i.test(text)) return false;
  if (/^[A-Za-z0-9_.:/@#?=&%+-]+\.(?:js|css|json|svg|png|jpg|woff2?|map)$/i.test(text)) return false;
  if (/^[a-f0-9]{24,}$/i.test(text)) return false;
  return true;
}

function baseName(url) {
  try { return path.posix.basename(new URL(url).pathname); }
  catch { return path.basename(url); }
}

function classifySource(url) {
  const name = baseName(url);
  if (/^(?:Translation|Translations|translation|translations|i18n|locale-en|en(?:-[A-Z]{2})?)-.*\.js$/i.test(name)) return 'english-catalog';
  if (/^(?:es|fr|de|it|pt|pl|ru|ja|ko|zh)(?:-[A-Z]{2})?-[A-Za-z0-9_-]+\.js$/i.test(name)) return 'foreign-locale';
  if (/vendor/i.test(name)) return 'vendor';
  if (/\.html?$/i.test(name)) return 'html';
  return 'app';
}

function setStats(a, b) {
  let n = 0;
  for (const value of a) if (b.has(value)) n++;
  return n;
}

async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch { return fallback; }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.staticDir || !args.mockDir || !args.existing) {
    console.log(usage());
    process.exit(args.help ? 0 : 2);
  }

  const candidates = await readJson(path.join(args.staticDir, 'candidates.json'), []);
  const staticReport = await readJson(path.join(args.staticDir, 'report.json'), {});
  const sdkRows = await readJson(path.join(args.mockDir, 'sdk-ui-strings.json'), []);
  const runtimeRows = await readJson(path.join(args.mockDir, 'runtime-text.json'), []);
  const mockReport = await readJson(path.join(args.mockDir, 'mock-report.json'), {});
  const existingPackage = await readJson(args.existing, {});
  const existing = new Set(Object.keys(existingPackage.translations || {}));

  const catalog = new Set();
  const appStatic = new Map();
  const sourceBreakdown = {};
  for (const candidate of candidates) {
    const text = normalize(candidate.text);
    if (!isCandidate(text)) continue;
    const roles = new Set((candidate.sources || []).map(classifySource));
    for (const source of candidate.sources || []) {
      const role = classifySource(source);
      const name = baseName(source);
      sourceBreakdown[name] ||= { role, candidates: 0, high: 0, medium: 0, low: 0 };
      sourceBreakdown[name].candidates++;
      sourceBreakdown[name][candidate.confidence || 'low']++;
    }
    if (roles.has('english-catalog')) catalog.add(text);
    if (!roles.has('vendor') && !roles.has('foreign-locale') && !roles.has('english-catalog') && Number(candidate.score) >= 4) {
      const current = appStatic.get(text);
      if (!current || Number(candidate.score) > current.score) appStatic.set(text, { text, score: Number(candidate.score), sources: candidate.sources || [] });
    }
  }

  const sdk = new Set(sdkRows.map(row => normalize(row.text)).filter(isCandidate));
  const runtime = new Set(runtimeRows.map(normalize).filter(isCandidate));
  const primary = new Map();
  function addOrigin(sourceSet, origin) {
    for (const text of sourceSet) {
      const row = primary.get(text) || { text, origins: new Set() };
      row.origins.add(origin);
      primary.set(text, row);
    }
  }
  addOrigin(catalog, 'i18n-catalog');
  addOrigin(sdk, 'sdk-registration');
  addOrigin(runtime, 'mock-dom');

  const primaryRows = [...primary.values()].map(row => ({
    text: row.text,
    origins: [...row.origins].sort(),
    existing: existing.has(row.text)
  })).sort((a, b) => a.text.localeCompare(b.text));

  const newPrimary = primaryRows.filter(row => !row.existing);
  const secondaryRows = [...appStatic.values()]
    .filter(row => !primary.has(row.text))
    .map(row => ({ ...row, existing: existing.has(row.text) }))
    .sort((a, b) => b.score - a.score || a.text.localeCompare(b.text));

  const oldSeen = [...existing].filter(text => primary.has(text));
  const summary = {
    manifest: staticReport.manifest || null,
    staticResources: staticReport.fetchedTextResources || 0,
    rawStaticCandidates: staticReport.uniqueCandidates || candidates.length,
    englishCatalog: catalog.size,
    sdkUiStrings: sdk.size,
    mockDomStrings: runtime.size,
    primaryUnion: primary.size,
    primaryNew: newPrimary.length,
    secondaryAppStatic: secondaryRows.length,
    existingTranslationCount: existing.size,
    existingSeenInPrimary: oldSeen.length,
    overlaps: {
      catalogSdk: setStats(catalog, sdk),
      catalogRuntime: setStats(catalog, runtime),
      sdkRuntime: setStats(sdk, runtime)
    },
    mock: {
      pageErrors: mockReport.pageErrors || [],
      navigationErrors: mockReport.navigation?.navigationErrors || [],
      snapshots: (mockReport.navigation?.snapshots || []).map(s => ({ name: s.name, uiStrings: s.uiStrings?.length || 0, bodyTextLength: s.bodyTextLength || 0 }))
    }
  };

  await fs.mkdir(args.outDir, { recursive: true });
  await fs.writeFile(path.join(args.outDir, 'high-confidence.json'), JSON.stringify(primaryRows, null, 2));
  await fs.writeFile(path.join(args.outDir, 'new-high-confidence.json'), JSON.stringify(newPrimary, null, 2));
  await fs.writeFile(path.join(args.outDir, 'secondary-static.json'), JSON.stringify(secondaryRows, null, 2));
  await fs.writeFile(path.join(args.outDir, 'source-breakdown.json'), JSON.stringify(sourceBreakdown, null, 2));
  await fs.writeFile(path.join(args.outDir, 'report.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
}

main().catch(error => { console.error(error); process.exit(1); });
