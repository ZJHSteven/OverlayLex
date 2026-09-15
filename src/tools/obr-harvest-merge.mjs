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

/**
 * Production i18n modules often contain a small Vite preload helper before the
 * actual translation dictionary. Treating every string inside Translation-*.js
 * as a translation value therefore leaks strings such as "modulepreload" and
 * CSS selectors into the corpus.
 *
 * A true catalog value usually has direct evidence in the scanner context such
 * as: "settings.defaultVisionRange":`Default Vision Range`.
 * When the scanner's three stored examples do not retain that exact occurrence,
 * keep normal human-readable values but reject common loader/runtime shapes.
 */
function isEnglishCatalogValue(candidate) {
  const catalogExamples = (candidate.examples || []).filter(example => classifySource(example.source) === 'english-catalog');
  const text = normalize(candidate.text);

  for (const example of catalogExamples) {
    const context = String(example.context || '');
    let from = 0;
    while (from < context.length) {
      const index = context.indexOf(text, from);
      if (index < 0) break;
      const before = context.slice(Math.max(0, index - 180), index);
      if (/(?:(?:"[^"\n]{1,160}"|'[^'\n]{1,160}')|[A-Za-z_$][\w$.-]{0,160})\s*:\s*[`"']\s*$/.test(before)) return true;
      from = index + Math.max(1, text.length);
    }
  }

  // Vite/Promise/CSP preload helper strings are code, not localizable UI.
  if (/^(?:en|load|link|script|stylesheet|modulepreload|nonce|fulfilled|rejected|error)$/i.test(text)) return false;
  if (/preload(?:Error| CSS)|csp-nonce|^\[rel=["']?stylesheet/i.test(text)) return false;
  if (/^meta\[property=/i.test(text)) return false;

  // Preserve short genuine values such as Solid, Dotted, Other, Roller and
  // Fly-Wheel even when their exact dictionary occurrence was not kept among
  // the scanner's limited example contexts.
  return Number(candidate.score) >= 1;
}

function setStats(a, b) {
  let n = 0;
  for (const value of a) if (b.has(value)) n++;
  return n;
}

const TEMPLATE_PLACEHOLDER_PATTERN = /{{\s*([A-Za-z_][A-Za-z0-9_.-]*)\s*}}/g;

function getTemplatePlaceholders(text) {
  return [...String(text || '').matchAll(new RegExp(TEMPLATE_PLACEHOLDER_PATTERN.source, 'g'))]
    .map(match => match[1]);
}

/**
 * 从生产 bundle 的 i18n 对象上下文里恢复作者原始 key。
 * 例如：`"settings.defaultVisionRange":`Default Vision Range``
 * 会得到 `settings.defaultVisionRange`，这对翻译者理解语义非常有帮助。
 */
function extractCatalogKeys(candidate, text) {
  const keys = new Set();
  for (const example of candidate?.examples || []) {
    if (classifySource(example.source) !== 'english-catalog') continue;
    const context = String(example.context || '');
    let from = 0;
    while (from < context.length) {
      const index = context.indexOf(text, from);
      if (index < 0) break;
      const before = context.slice(Math.max(0, index - 220), index);
      const matched = before.match(/(?:(?:"([^"\n]{1,180})"|'([^'\n]{1,180})')|([A-Za-z_$][\w$.-]{0,180}))\s*:\s*[`"']\s*$/);
      const key = matched?.[1] || matched?.[2] || matched?.[3] || '';
      if (key) keys.add(key);
      from = index + Math.max(1, text.length);
    }
  }
  return [...keys].sort();
}

function compactSourceExample(example) {
  const context = normalize(example?.context || '');
  return {
    source: String(example?.source || ''),
    offset: Number.isFinite(example?.offset) ? example.offset : null,
    // 只保留翻译判断所需的一小段上下文，避免 sidecar 变成生产 bundle 的复制品。
    context: context.length > 420 ? `${context.slice(0, 417)}...` : context
  };
}

/**
 * 把作者 i18n catalog 中的条目恢复为“同一文件内的相邻顺序”。
 *
 * 为什么要做这一步：
 * 翻译人员真正需要的上下文通常不是 `Translation-xxx.js` 这个文件名，
 * 而是“这句话前后还有哪些设置项/提示语”。生产 bundle 虽然被压缩了，
 * 但字符串在同一个 catalog 对象里的顺序仍然稳定；Harvester 已保存 offset，
 * 因此可以给每条文案找上一条和下一条，作为接近自然语言阅读体验的上下文。
 */
function buildCatalogNeighbors(candidates) {
  const bySource = new Map();

  for (const candidate of candidates || []) {
    const text = normalize(candidate?.text);
    if (!text) continue;
    for (const example of candidate?.examples || []) {
      if (classifySource(example?.source) !== 'english-catalog') continue;
      if (!Number.isFinite(example?.offset)) continue;
      const source = String(example.source || '');
      const rows = bySource.get(source) || [];
      rows.push({ text, offset: example.offset });
      bySource.set(source, rows);
    }
  }

  const neighbors = new Map();
  for (const rows of bySource.values()) {
    rows.sort((a, b) => a.offset - b.offset);
    const deduped = [];
    for (const row of rows) {
      if (deduped.at(-1)?.text === row.text) continue;
      deduped.push(row);
    }
    for (let index = 0; index < deduped.length; index++) {
      const current = deduped[index];
      if (neighbors.has(current.text)) continue;
      neighbors.set(current.text, {
        previous: deduped[index - 1]?.text || '',
        next: deduped[index + 1]?.text || '',
      });
    }
  }
  return neighbors;
}

function humanizeMockPage(pageName) {
  const raw = String(pageName || '').replace(/^nav:/i, '').trim();
  const key = raw.toLowerCase();
  const labels = {
    main: '主界面',
    spectre: 'Spectre 页面',
    presets: '预设页面',
    defaults: '默认值页面',
    settings: '设置页面',
    import: '导入与转换页面',
  };
  return labels[key] || raw;
}

function humanizeI18nArea(i18nKeys) {
  const key = String(i18nKeys?.[0] || '');
  if (!key) return '';
  const [section, subsection] = key.split('.');
  const sectionLabels = {
    main: '主界面',
    settings: '设置',
    defaults: '默认值',
    presets: '预设',
    spectre: 'Spectre',
    conversion: '导入与转换',
    notice: '更新公告',
    wallOps: '墙体操作',
    doorOps: '门操作',
    windowOps: '窗户操作',
    vision: '视野',
    fog: '迷雾',
  };
  const subsectionLabels = {
    modal: '弹窗',
    tooltips: '提示说明',
    aria: '按钮/无障碍提示',
    errors: '错误提示',
  };
  const first = sectionLabels[section] || '';
  const second = subsectionLabels[subsection] || '';
  return [first, second].filter(Boolean).join(' → ');
}

function humanizeSdkLocation(sdkRows) {
  const ids = new Set((sdkRows || []).map(item => String(item?.messageId || '')));
  if ([...ids].some(id => id.includes('CONTEXT_MENU'))) return 'Owlbear Rodeo 右键菜单';
  if ([...ids].some(id => id.includes('TOOL_MODE'))) return 'Owlbear Rodeo 工具栏 → 工具模式';
  if ([...ids].some(id => id.includes('TOOL_ACTION'))) return 'Owlbear Rodeo 工具栏 → 工具操作';
  if ([...ids].some(id => id.includes('TOOL_CREATE'))) return 'Owlbear Rodeo 工具栏';
  if ([...ids].some(id => id.includes('NOTIFICATION'))) return 'Owlbear Rodeo 通知';
  if ([...ids].some(id => id.includes('MODAL'))) return 'Owlbear Rodeo 弹窗';
  if ([...ids].some(id => id.includes('POPOVER'))) return 'Owlbear Rodeo 弹出面板';
  return ids.size > 0 ? 'Owlbear Rodeo 宿主界面' : '';
}

function describePlaceholder(name) {
  const labels = {
    count: '数量',
    name: '名称/玩家名',
    message: '运行时提示或错误信息',
    skippedText: '“已跳过”附加说明',
    dedupeText: '“已去除重复项”附加说明',
  };
  return labels[name] || '运行时动态内容';
}

/**
 * 生成直接给翻译人员看的自然语言上下文。
 *
 * sidecar 里仍保留 i18n key / SDK messageId / bundle source 等开发信息，
 * 但这些字段不应该成为 ParaTranz 默认展示内容。这里专门把技术元数据翻译成：
 * “出现在哪里、附近还有什么文案、占位符代表什么”。
 */
function buildTranslatorContext({ i18nKeys, sdk, mockPages, placeholders, neighbors }) {
  const lines = [];
  const pageLabels = [...new Set((mockPages || []).map(humanizeMockPage).filter(Boolean))];
  const sdkLocation = humanizeSdkLocation(sdk);
  const i18nArea = humanizeI18nArea(i18nKeys);

  if (pageLabels.length > 0) {
    lines.push(`出现位置：Smoke & Spectre → ${pageLabels.join(' / ')}`);
  } else if (sdkLocation) {
    lines.push(`出现位置：${sdkLocation}`);
  } else if (i18nArea) {
    lines.push(`出现位置：Smoke & Spectre → ${i18nArea}`);
  } else {
    lines.push('出现位置：Smoke & Spectre 界面');
  }

  const neighborParts = [];
  if (neighbors?.previous) neighborParts.push(`上一条「${neighbors.previous}」`);
  if (neighbors?.next) neighborParts.push(`下一条「${neighbors.next}」`);
  if (neighborParts.length > 0) {
    lines.push(`相邻文案：${neighborParts.join('；')}`);
  }

  if ((placeholders || []).length > 0) {
    const descriptions = placeholders.map(name => `{{${name}}} 表示${describePlaceholder(name)}`);
    lines.push(`变量说明：${descriptions.join('；')}。翻译时请原样保留变量名。`);
  }

  return lines.join('\n');
}

/**
 * 生成“只给维护/翻译流程使用”的上下文 sidecar。
 * 它不会进入浏览器运行时翻译包，因此可以保存 i18n key、SDK API、页面位置等诊断信息。
 */
function buildContextSidecar({ primaryRows, candidates, sdkRows, mockReport, existingPackage, staticReport }) {
  const candidateByText = new Map(candidates.map(candidate => [normalize(candidate.text), candidate]));
  const catalogNeighbors = buildCatalogNeighbors(candidates);
  const sdkByText = new Map();
  for (const row of sdkRows || []) {
    const text = normalize(row?.text);
    if (!text) continue;
    const list = sdkByText.get(text) || [];
    list.push({
      messageId: String(row?.messageId || ''),
      path: String(row?.path || '')
    });
    sdkByText.set(text, list);
  }

  const mockPagesByText = new Map();
  for (const snapshot of mockReport?.navigation?.snapshots || []) {
    const pageName = String(snapshot?.name || '');
    for (const rawText of snapshot?.uiStrings || []) {
      const text = normalize(rawText);
      if (!text) continue;
      const pages = mockPagesByText.get(text) || new Set();
      if (pageName) pages.add(pageName);
      mockPagesByText.set(text, pages);
    }
  }

  const entries = {};
  for (const row of primaryRows) {
    const text = row.text;
    const candidate = candidateByText.get(text);
    const placeholders = getTemplatePlaceholders(text);
    const sources = [...new Set(candidate?.sources || [])]
      .filter(source => !['vendor', 'foreign-locale'].includes(classifySource(source)))
      .sort();
    const examples = (candidate?.examples || [])
      .filter(example => !['vendor', 'foreign-locale'].includes(classifySource(example.source)))
      .slice(0, 2)
      .map(compactSourceExample);
    const sdk = sdkByText.get(text) || [];
    const mockPages = [...(mockPagesByText.get(text) || new Set())].sort();
    const neighbors = catalogNeighbors.get(text) || { previous: '', next: '' };

    entries[text] = {
      kind: placeholders.length > 0 ? 'template' : 'literal',
      placeholders,
      origins: [...row.origins],
      i18nKeys: extractCatalogKeys(candidate, text),
      sdk,
      mockPages,
      neighbors,
      translatorContext: buildTranslatorContext({
        i18nKeys: extractCatalogKeys(candidate, text),
        sdk,
        mockPages,
        placeholders,
        neighbors,
      }),
      sources,
      examples
    };
  }

  return {
    schemaVersion: 2,
    packageId: String(existingPackage?.id || ''),
    manifestVersion: String(staticReport?.manifest?.version || ''),
    entries
  };
}

/**
 * 判断一条运行时 DOM 文本是否包含 Mock fixture 注入的动态值。
 *
 * 这里只过滤 `mock-dom` 来源，不碰 i18n catalog / SDK registration：
 * 如果某个字符串同时存在于扩展自己的固定词典里，它仍会通过其它来源进入主语料。
 */
function isFixtureDerivedRuntimeText(text, volatileTokens) {
  const normalizedText = normalize(text).toLocaleLowerCase();
  if (!normalizedText) return false;

  return volatileTokens.some(token => {
    const normalizedToken = normalize(token).toLocaleLowerCase();
    return normalizedToken.length >= 2 && normalizedText.includes(normalizedToken);
  });
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
  let rejectedCatalogNoise = 0;

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

    if (roles.has('english-catalog')) {
      if (isEnglishCatalogValue(candidate)) catalog.add(text);
      else rejectedCatalogNoise++;
    }

    if (!roles.has('vendor') && !roles.has('foreign-locale') && !roles.has('english-catalog') && Number(candidate.score) >= 4) {
      const current = appStatic.get(text);
      if (!current || Number(candidate.score) > current.score) appStatic.set(text, { text, score: Number(candidate.score), sources: candidate.sources || [] });
    }
  }

  const sdk = new Set(sdkRows.map(row => normalize(row.text)).filter(isCandidate));
  const volatileRuntimeTokens = (mockReport.volatileRuntimeTokens || [])
    .map(normalize)
    .filter(Boolean);
  const rejectedFixtureRuntimeText = [];
  const runtime = new Set();
  for (const rawText of runtimeRows) {
    const text = normalize(rawText);
    if (!isCandidate(text)) continue;
    if (isFixtureDerivedRuntimeText(text, volatileRuntimeTokens)) {
      rejectedFixtureRuntimeText.push(text);
      continue;
    }
    runtime.add(text);
  }
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
  const contextSidecar = buildContextSidecar({
    primaryRows,
    candidates,
    sdkRows,
    mockReport,
    existingPackage,
    staticReport
  });
  const summary = {
    manifest: staticReport.manifest || null,
    staticResources: staticReport.fetchedTextResources || 0,
    rawStaticCandidates: staticReport.uniqueCandidates || candidates.length,
    englishCatalog: catalog.size,
    rejectedCatalogNoise,
    sdkUiStrings: sdk.size,
    mockDomStrings: runtime.size,
    rejectedFixtureRuntimeText: rejectedFixtureRuntimeText.length,
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
  await fs.writeFile(path.join(args.outDir, 'fixture-derived-runtime.json'), JSON.stringify(rejectedFixtureRuntimeText.sort((a, b) => a.localeCompare(b)), null, 2));
  await fs.writeFile(path.join(args.outDir, 'source-breakdown.json'), JSON.stringify(sourceBreakdown, null, 2));
  await fs.writeFile(path.join(args.outDir, 'context-sidecar.json'), JSON.stringify(contextSidecar, null, 2));
  await fs.writeFile(path.join(args.outDir, 'report.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
}

main().catch(error => { console.error(error); process.exit(1); });
