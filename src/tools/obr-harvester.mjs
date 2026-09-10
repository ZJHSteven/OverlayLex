#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const DEFAULT_MAX_ASSETS = 300;
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const TEXT_EXTENSIONS = new Set(['.html','.htm','.js','.mjs','.cjs','.css','.json','.map','.txt','.svg']);
const BINARY_EXTENSIONS = new Set(['.png','.jpg','.jpeg','.gif','.webp','.ico','.woff','.woff2','.ttf','.otf','.mp3','.wav','.ogg','.mp4','.webm','.zip','.gz','.br','.wasm']);
const UI_HINTS = [
  'label','title','children','placeholder','description','helpertext','helperText','tooltip','aria-label',
  'aria-description','aria-valuetext','message','caption','heading','button','dialog','menu','toast','notification'
];
const OBR_HINTS = [
  'obr.tool','obr.contextmenu','obr.contextMenu','obr.modal','obr.popover','obr.notification','obr.action',
  'contextmenu.create','contextMenu.create','tool.create','modal.open','popover.open','notification.show'
];
const INTERNAL_HINTS = [
  'import ',' from ','modulepreload','classname','className','stylesheet','sourceMappingURL','content-type',
  'application/','text/javascript','image/','font/','fetch(','new url','new URL','http://','https://','data:'
];
const COMMON_UI_WORDS = new Set([
  'add','apply','back','cancel','clear','close','confirm','continue','copy','create','delete','disable','disabled',
  'done','edit','enable','enabled','error','export','help','hide','import','loading','menu','next','no','none','ok',
  'open','previous','refresh','remove','reset','retry','save','search','select','settings','show','start','stop',
  'submit','update','warning','yes','opacity','color','size','style','vision','range','door','doors','wall','walls'
]);

function parseArgs(argv) {
  const result = { manifestUrl: null, outDir: '.harvest/obr', existing: null, maxAssets: DEFAULT_MAX_ASSETS, maxBytes: DEFAULT_MAX_BYTES };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--') && !result.manifestUrl) result.manifestUrl = arg;
    else if (arg === '--out') result.outDir = argv[++i];
    else if (arg === '--existing') result.existing = argv[++i];
    else if (arg === '--max-assets') result.maxAssets = Number(argv[++i]);
    else if (arg === '--max-bytes') result.maxBytes = Number(argv[++i]);
    else if (arg === '--help' || arg === '-h') result.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return result;
}

function usage() {
  return `Usage: node src/tools/obr-harvester.mjs <manifest-url> [options]\n\n` +
    `Options:\n  --out <dir>          Output directory (default: .harvest/obr)\n` +
    `  --existing <json>   Existing OverlayLex package for diff\n` +
    `  --max-assets <n>     Maximum textual assets to fetch\n` +
    `  --max-bytes <n>      Maximum bytes per textual asset\n`;
}

function normalizeText(value) {
  return value
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\"/g, '"')
    .replace(/\\'/g, "'")
    .replace(/\\`/g, '`')
    .replace(/\\\\/g, '\\')
    .replace(/\s+/g, ' ')
    .trim();
}

function isLikelyUiText(text) {
  if (!text || text.length < 2 || text.length > 220) return false;
  if (!/[A-Za-z]/.test(text)) return false;
  if (/^(?:https?:|data:|blob:|mailto:|tel:|\/\/)/i.test(text)) return false;
  if (/^[A-Za-z0-9_./:@#?=&%+-]+\.(?:js|mjs|css|json|map|svg|png|jpg|woff2?|ttf|wasm)(?:\?.*)?$/i.test(text)) return false;
  if (/^(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/i.test(text)) return false;
  if (/^[a-f0-9]{24,}$/i.test(text) || /^[A-Za-z0-9+/]{48,}={0,2}$/.test(text)) return false;
  if (/^[.#][A-Za-z0-9_-]+$/.test(text)) return false;
  if (/^[A-Z0-9_]{4,}$/.test(text) && !text.includes(' ')) return false;
  if (/^[a-z][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)+$/.test(text)) return false;
  const letters = (text.match(/[A-Za-z]/g) || []).length;
  const punctuation = (text.match(/[^A-Za-z0-9\s'"!?.,:;()&/+%-]/g) || []).length;
  if (letters < 2 || punctuation > Math.max(8, Math.floor(text.length * 0.25))) return false;
  return true;
}

function scoreCandidate(text, context) {
  const lowerText = text.toLowerCase();
  const lowerContext = context.toLowerCase();
  let score = 0;
  const reasons = [];
  if (/\s/.test(text)) { score += 2; reasons.push('contains-space'); }
  if (/^[A-Z][A-Za-z0-9'’&/+ -]{1,60}$/.test(text)) { score += 1; reasons.push('title-shape'); }
  if (/[.!?]$/.test(text)) { score += 1; reasons.push('sentence-shape'); }
  if (COMMON_UI_WORDS.has(lowerText)) { score += 3; reasons.push('common-ui-word'); }
  for (const hint of UI_HINTS) {
    if (lowerContext.includes(hint.toLowerCase())) { score += 2; reasons.push(`ui-context:${hint}`); break; }
  }
  for (const hint of OBR_HINTS) {
    if (lowerContext.includes(hint.toLowerCase())) { score += 3; reasons.push(`obr-context:${hint}`); break; }
  }
  if (/jsx|jsxs|createelement|typography|button|menuitem|dialogtitle|formcontrol|textfield/i.test(context)) {
    score += 1; reasons.push('render-context');
  }
  for (const hint of INTERNAL_HINTS) {
    if (lowerContext.includes(hint.toLowerCase())) { score -= 2; reasons.push(`internal-context:${hint}`); break; }
  }
  if (/^[a-z][a-z0-9_-]{2,}$/.test(text) && !COMMON_UI_WORDS.has(lowerText)) {
    score -= 1; reasons.push('internal-token-shape');
  }
  if (/^[A-Za-z0-9_-]+\/[A-Za-z0-9_./-]+$/.test(text)) {
    score -= 3; reasons.push('path-shape');
  }
  return { score, reasons };
}

function scanQuotedStrings(source, sourceName) {
  const found = [];
  const length = source.length;
  for (let i = 0; i < length; i++) {
    const quote = source[i];
    if (quote !== '"' && quote !== "'" && quote !== '`') continue;
    const start = i;
    let value = '';
    let escaped = false;
    let templateExpression = false;
    i++;
    for (; i < length; i++) {
      const ch = source[i];
      if (escaped) { value += `\\${ch}`; escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (quote === '`' && ch === '$' && source[i + 1] === '{') { templateExpression = true; value += ' ${…} '; i++; continue; }
      if (ch === quote) break;
      if (ch === '\n' || ch === '\r') {
        if (quote !== '`') { value = ''; break; }
        value += ' ';
      } else value += ch;
    }
    if (!value) continue;
    const text = normalizeText(value);
    if (!isLikelyUiText(text)) continue;
    const left = Math.max(0, start - 180);
    const right = Math.min(length, i + 180);
    const context = source.slice(left, right).replace(/\s+/g, ' ');
    const { score, reasons } = scoreCandidate(text, context);
    found.push({ text, score, reasons, source: sourceName, offset: start, templateExpression, context: context.slice(0, 360) });
  }
  return found;
}

function scanHtmlText(source, sourceName) {
  const out = [];
  const stripped = source
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--([\s\S]*?)-->/g, ' ');
  const re = />([^<>]{2,220})</g;
  let match;
  while ((match = re.exec(stripped))) {
    const text = normalizeText(match[1].replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&'));
    if (!isLikelyUiText(text)) continue;
    out.push({ text, score: 4, reasons: ['html-visible-text'], source: sourceName, offset: match.index, templateExpression: false, context: match[0].slice(0, 360) });
  }
  return out;
}

function resolveUrl(raw, base) {
  try {
    if (!raw || raw.startsWith('#') || raw.startsWith('data:') || raw.startsWith('blob:') || raw.startsWith('mailto:')) return null;
    return new URL(raw, base).href;
  } catch { return null; }
}

function extractRefs(source, url, contentType) {
  const refs = new Set();
  const add = raw => { const resolved = resolveUrl(raw, url); if (resolved) refs.add(resolved); };
  if (contentType.includes('html') || /\.html?(?:$|\?)/i.test(url) || /\/pages\/?(?:$|\?)/i.test(url)) {
    for (const re of [/<script[^>]+src=["']([^"']+)["']/gi, /<link[^>]+href=["']([^"']+)["']/gi]) {
      let m; while ((m = re.exec(source))) add(m[1]);
    }
  }
  if (contentType.includes('javascript') || /\.(?:m?js|cjs)(?:$|\?)/i.test(url)) {
    const regexes = [
      /\bimport\s*(?:[^'"`]*?\sfrom\s*)?["'`]([^"'`]+)["'`]/g,
      /\bexport\s+[^'"`]*?\sfrom\s*["'`]([^"'`]+)["'`]/g,
      /\bimport\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/g,
      /new\s+URL\s*\(\s*["'`]([^"'`]+)["'`]\s*,\s*import\.meta\.url\s*\)/g,
      /\/\/[#@]\s*sourceMappingURL=([^\s]+)/g
    ];
    for (const re of regexes) { let m; while ((m = re.exec(source))) add(m[1]); }
    const routeRe = /["'`]((?:\/|\.\.?\/)[A-Za-z0-9_@%+.,~!$&'()*;=:\/-]+\.(?:js|mjs|css|json|map|html?)(?:\?[^"'`]*)?)["'`]/g;
    let rm; while ((rm = routeRe.exec(source))) add(rm[1]);
  }
  if (contentType.includes('css') || /\.css(?:$|\?)/i.test(url)) {
    const re = /(?:@import\s+(?:url\()?|url\()["']?([^"')\s]+)["']?\)?/gi;
    let m; while ((m = re.exec(source))) add(m[1]);
  }
  return [...refs];
}

function manifestEntryUrls(manifest, manifestUrl) {
  const urls = new Set();
  function walk(value, key = '') {
    if (typeof value === 'string') {
      const k = key.toLowerCase();
      if (k.includes('url') || k.includes('popover') || k.includes('background') || k.includes('icon') || /^https?:|^\//.test(value)) {
        const resolved = resolveUrl(value, manifestUrl);
        if (resolved) urls.add(resolved);
      }
    } else if (Array.isArray(value)) value.forEach(v => walk(v, key));
    else if (value && typeof value === 'object') Object.entries(value).forEach(([k,v]) => walk(v, k));
  }
  walk(manifest);
  return [...urls];
}

async function fetchText(url, maxBytes) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'user-agent': 'OverlayLex-OBR-Harvester/0.1 (+https://github.com/ZJHSteven/OverlayLex)' }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const contentLength = Number(response.headers.get('content-length') || 0);
    if (contentLength > maxBytes) throw new Error(`asset too large (${contentLength} bytes)`);
    const buffer = new Uint8Array(await response.arrayBuffer());
    if (buffer.byteLength > maxBytes) throw new Error(`asset too large (${buffer.byteLength} bytes)`);
    const contentType = response.headers.get('content-type') || '';
    return { text: new TextDecoder('utf-8', { fatal: false }).decode(buffer), contentType, finalUrl: response.url, bytes: buffer.byteLength };
  } finally { clearTimeout(timer); }
}

function classifyTextAsset(url, contentType) {
  const ext = path.extname(new URL(url).pathname).toLowerCase();
  if (BINARY_EXTENSIONS.has(ext)) return false;
  if (TEXT_EXTENSIONS.has(ext)) return true;
  return /(?:text\/|javascript|json|xml|svg|css|html)/i.test(contentType);
}

function mergeCandidates(candidates) {
  const map = new Map();
  for (const item of candidates) {
    const key = item.text;
    const current = map.get(key) || { text: key, score: -Infinity, occurrences: 0, sources: new Set(), reasons: new Set(), examples: [] };
    current.score = Math.max(current.score, item.score);
    current.occurrences++;
    current.sources.add(item.source);
    item.reasons.forEach(r => current.reasons.add(r));
    if (current.examples.length < 3) current.examples.push({ source: item.source, context: item.context, score: item.score });
    map.set(key, current);
  }
  return [...map.values()].map(v => ({
    text: v.text,
    score: v.score,
    confidence: v.score >= 4 ? 'high' : v.score >= 2 ? 'medium' : 'low',
    occurrences: v.occurrences,
    sources: [...v.sources].sort(),
    reasons: [...v.reasons].sort(),
    examples: v.examples
  })).sort((a,b) => b.score - a.score || a.text.localeCompare(b.text));
}

async function loadExistingTranslations(file) {
  if (!file) return new Set();
  const raw = JSON.parse(await fs.readFile(file, 'utf8'));
  return new Set(Object.keys(raw.translations || {}));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.manifestUrl) { console.log(usage()); process.exit(args.help ? 0 : 2); }
  const manifestUrl = new URL(args.manifestUrl).href;
  const origin = new URL(manifestUrl).origin;
  await fs.mkdir(args.outDir, { recursive: true });

  const manifestResponse = await fetchText(manifestUrl, args.maxBytes);
  const manifest = JSON.parse(manifestResponse.text);
  const queue = manifestEntryUrls(manifest, manifestUrl).map(url => ({ url, discoveredBy: 'manifest' }));
  const seen = new Set([manifestUrl]);
  const resources = [{ url: manifestUrl, finalUrl: manifestResponse.finalUrl, contentType: manifestResponse.contentType, bytes: manifestResponse.bytes, discoveredBy: 'root-manifest', status: 'ok' }];
  const rawCandidates = [];
  const errors = [];

  while (queue.length && resources.length < args.maxAssets + 1) {
    const next = queue.shift();
    if (!next?.url || seen.has(next.url)) continue;
    seen.add(next.url);
    const parsed = new URL(next.url);
    if (parsed.origin !== origin) {
      resources.push({ url: next.url, discoveredBy: next.discoveredBy, status: 'external-skipped' });
      continue;
    }
    const ext = path.extname(parsed.pathname).toLowerCase();
    if (BINARY_EXTENSIONS.has(ext)) {
      resources.push({ url: next.url, discoveredBy: next.discoveredBy, status: 'binary-skipped' });
      continue;
    }
    try {
      const response = await fetchText(next.url, args.maxBytes);
      if (!classifyTextAsset(response.finalUrl, response.contentType)) {
        resources.push({ url: next.url, finalUrl: response.finalUrl, contentType: response.contentType, bytes: response.bytes, discoveredBy: next.discoveredBy, status: 'non-text-skipped' });
        continue;
      }
      resources.push({ url: next.url, finalUrl: response.finalUrl, contentType: response.contentType, bytes: response.bytes, discoveredBy: next.discoveredBy, status: 'ok' });
      rawCandidates.push(...scanQuotedStrings(response.text, response.finalUrl));
      if (/html/i.test(response.contentType) || /\/pages\/?(?:$|\?)/i.test(response.finalUrl) || /\.html?(?:$|\?)/i.test(response.finalUrl)) {
        rawCandidates.push(...scanHtmlText(response.text, response.finalUrl));
      }
      for (const ref of extractRefs(response.text, response.finalUrl, response.contentType)) {
        if (!seen.has(ref)) queue.push({ url: ref, discoveredBy: response.finalUrl });
      }
    } catch (error) {
      errors.push({ url: next.url, discoveredBy: next.discoveredBy, error: String(error?.message || error) });
      resources.push({ url: next.url, discoveredBy: next.discoveredBy, status: 'error', error: String(error?.message || error) });
    }
  }

  const candidates = mergeCandidates(rawCandidates);
  const existing = await loadExistingTranslations(args.existing);
  const enriched = candidates.map(c => ({ ...c, existing: existing.has(c.text) }));
  const stats = {
    manifest: { url: manifestUrl, name: manifest.name || null, version: manifest.version || null, manifestVersion: manifest.manifest_version || null },
    resourceCount: resources.length,
    fetchedTextResources: resources.filter(r => r.status === 'ok').length,
    errors: errors.length,
    uniqueCandidates: enriched.length,
    highConfidence: enriched.filter(c => c.confidence === 'high').length,
    mediumConfidence: enriched.filter(c => c.confidence === 'medium').length,
    lowConfidence: enriched.filter(c => c.confidence === 'low').length,
    existingMatches: enriched.filter(c => c.existing).length,
    newHighConfidence: enriched.filter(c => !c.existing && c.confidence === 'high').length,
    newMediumConfidence: enriched.filter(c => !c.existing && c.confidence === 'medium').length,
    oldTranslationCount: existing.size,
    oldTranslationsStillSeen: [...existing].filter(text => enriched.some(c => c.text === text)).length
  };

  await fs.writeFile(path.join(args.outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  await fs.writeFile(path.join(args.outDir, 'asset-graph.json'), JSON.stringify({ resources, errors }, null, 2));
  await fs.writeFile(path.join(args.outDir, 'candidates.json'), JSON.stringify(enriched, null, 2));
  await fs.writeFile(path.join(args.outDir, 'new-candidates.json'), JSON.stringify(enriched.filter(c => !c.existing && c.score >= 2), null, 2));
  await fs.writeFile(path.join(args.outDir, 'report.json'), JSON.stringify(stats, null, 2));

  console.log(JSON.stringify(stats, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('obr-harvester.mjs')) {
  main().catch(error => { console.error(error); process.exit(1); });
}

export { scanQuotedStrings, scanHtmlText, extractRefs, isLikelyUiText, scoreCandidate, mergeCandidates };
