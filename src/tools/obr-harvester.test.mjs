import test from 'node:test';
import assert from 'node:assert/strict';
import { scanQuotedStrings, scanHtmlText, extractRefs, mergeCandidates } from './obr-harvester.mjs';

test('extracts compiled React/MUI UI text and deprioritizes imports', () => {
  const src = `import x from './chunk-a.js'; const a=jsx(Button,{children:"Enable Vision",title:"Settings"}); fetch("/api/state.json");`;
  const rows = mergeCandidates(scanQuotedStrings(src, 'main.js'));
  const enable = rows.find(r => r.text === 'Enable Vision');
  const settings = rows.find(r => r.text === 'Settings');
  assert.ok(enable && enable.score >= 4);
  assert.ok(settings && settings.score >= 3);
  assert.equal(rows.some(r => r.text === './chunk-a.js'), false);
});

test('extracts visible HTML text', () => {
  const rows = scanHtmlText('<main><h1>Smoke Settings</h1><button>Save</button></main>', 'page.html');
  assert.deepEqual(rows.map(r => r.text), ['Smoke Settings', 'Save']);
});

test('discovers same-page module and sourcemap references', () => {
  const src = `import './chunk.js'; import("./lazy.js"); //# sourceMappingURL=main.js.map`;
  const refs = extractRefs(src, 'https://example.test/assets/main.js', 'text/javascript');
  assert.ok(refs.includes('https://example.test/assets/chunk.js'));
  assert.ok(refs.includes('https://example.test/assets/lazy.js'));
  assert.ok(refs.includes('https://example.test/assets/main.js.map'));
});
