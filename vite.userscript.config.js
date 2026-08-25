import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import monkey from 'vite-plugin-monkey';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

const preserveLegacyIifeBoundary = {
  name: 'overlaylex-preserve-legacy-iife-boundary',
  enforce: 'pre',
  transform(code, id) {
    const normalizedId = id.replaceAll('\\', '/').split('?')[0];
    if (!normalizedId.endsWith('/src/userscript/overlaylex.user.js')) {
      return null;
    }

    // The legacy runtime starts with an IIFE. When it is imported as a side-effect
    // module, Rollup may concatenate that leading `(` directly after the wrapper's
    // "use strict" string and produce `"use strict"(function...)`, which is valid
    // syntax but calls the string at runtime and immediately throws TypeError.
    // Prefixing the legacy IIFE with an explicit statement separator keeps the
    // source unchanged while making the bundled UserScript boundary unambiguous.
    const marker = '(function overlayLexBootstrap() {';
    if (!code.includes(marker)) {
      throw new Error('OverlayLex legacy bootstrap marker not found.');
    }
    return code.replace(marker, `;${marker}`);
  },
};

export default defineConfig({
  build: {
    outDir: 'dist/userscript',
    emptyOutDir: true,
    minify: false,
  },
  plugins: [
    preserveLegacyIifeBoundary,
    monkey({
      entry: 'src/userscript/overlaylex.entry.js',
      userscript: {
        name: 'OverlayLex Translator',
        namespace: 'https://github.com/ZJHSteven/OverlayLex',
        version: pkg.version,
        description: 'OverlayLex 主翻译脚本：按域名加载翻译包并执行页面文本覆盖翻译。',
        author: 'OverlayLex',
        match: ['*://*/*'],
        grant: ['GM_getValue', 'GM_setValue'],
        runAt: 'document-end',
        updateURL: 'https://raw.githubusercontent.com/ZJHSteven/OverlayLex/main/src/userscript/overlaylex.user.js',
        downloadURL: 'https://raw.githubusercontent.com/ZJHSteven/OverlayLex/main/src/userscript/overlaylex.user.js',
      },
      build: {
        fileName: 'overlaylex.user.js',
        metaFileName: 'overlaylex.meta.js',
      },
    }),
  ],
});
