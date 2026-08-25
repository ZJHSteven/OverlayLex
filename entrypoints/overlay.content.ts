export default defineContentScript({
  matches: ['<all_urls>'],
  allFrames: true,
  runAt: 'document_end',
  world: 'ISOLATED',
  async main() {
    // The legacy UserScript remains the single runtime implementation during
    // phase 1 of the migration. Loading it here lets WXT package the same code
    // for Chrome, Edge, and Firefox without maintaining a fork.
    await import('../src/userscript/overlaylex.user.js');
  },
});
