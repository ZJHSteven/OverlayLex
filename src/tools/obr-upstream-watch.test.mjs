import test from 'node:test';
import assert from 'node:assert/strict';
import {
  stableAssetGraphHash,
  stableCorpusHash,
  uniqueOriginals,
  hasSubstantiveStateChange
} from './obr-upstream-watch.mjs';

test('original 去重必须大小写敏感', () => {
  const rows = [
    { text: 'Ignore hidden tokens' },
    { text: 'Ignore Hidden Tokens' },
    { text: 'Ignore hidden tokens' }
  ];
  assert.deepEqual(uniqueOriginals(rows), ['Ignore Hidden Tokens', 'Ignore hidden tokens']);
});

test('语料哈希对顺序稳定、对大小写敏感', () => {
  assert.equal(
    stableCorpusHash([{ text: 'B' }, { text: 'A' }]),
    stableCorpusHash([{ text: 'A' }, { text: 'B' }])
  );
  assert.notEqual(
    stableCorpusHash([{ text: 'A' }]),
    stableCorpusHash([{ text: 'a' }])
  );
});

test('资源图哈希包含内容 SHA-256 且不受数组顺序影响', () => {
  const first = {
    resources: [
      { status: 'ok', finalUrl: 'https://example.test/b.js', bytes: 10, contentType: 'text/javascript', sha256: 'bbb' },
      { status: 'ok', finalUrl: 'https://example.test/a.js', bytes: 10, contentType: 'text/javascript', sha256: 'aaa' }
    ]
  };
  const reordered = { resources: [...first.resources].reverse() };
  assert.equal(stableAssetGraphHash(first), stableAssetGraphHash(reordered));

  const changedContent = structuredClone(first);
  changedContent.resources[0].sha256 = 'different';
  assert.notEqual(stableAssetGraphHash(first), stableAssetGraphHash(changedContent));
});

test('状态只对真实基线变化敏感', () => {
  const baseline = { manifestVersion: '5.0.3', assetGraphHash: 'a', corpusHash: 'b' };
  assert.equal(hasSubstantiveStateChange(baseline, { ...baseline }), false);
  assert.equal(hasSubstantiveStateChange(baseline, { ...baseline, manifestVersion: '5.0.4' }), true);
});
