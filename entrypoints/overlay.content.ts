import { browser } from 'wxt/browser';

type OverlayLexExtensionStorageBridge = {
  get(key: string, fallbackValue: unknown): unknown;
  set(key: string, value: unknown): void;
};

type OverlayLexGlobal = typeof globalThis & {
  __OVERLAYLEX_EXTENSION_STORAGE__?: OverlayLexExtensionStorageBridge;
};

export default defineContentScript({
  matches: ['<all_urls>'],
  allFrames: true,
  runAt: 'document_end',
  world: 'ISOLATED',
  async main() {
    /**
     * WebExtension 与 UserScript 共用同一个 legacy runtime，因此这里不能直接把
     * `browser.storage.local.get()` 这种异步 API 塞进旧运行时的同步初始化路径。
     *
     * 处理办法是：
     * 1) 在真正 import 旧运行时之前，一次性把扩展级 local storage 读入内存；
     * 2) 暴露一个只在 WXT content-script 隔离世界里存在的同步桥；
     * 3) 旧运行时继续使用同步 get/set，但底层写入会异步落到 browser.storage.local。
     *
     * 这样既不需要复制一份翻译核心，也解决了页面 localStorage 按域隔离的问题：
     * Owlbear 主站和第三方插件 iframe 都会读写同一份扩展级缓存。
     */
    const snapshot = await browser.storage.local.get(null);
    const memoryCache: Record<string, unknown> = { ...snapshot };
    const target = globalThis as OverlayLexGlobal;

    target.__OVERLAYLEX_EXTENSION_STORAGE__ = {
      get(key, fallbackValue) {
        return Object.prototype.hasOwnProperty.call(memoryCache, key)
          ? memoryCache[key]
          : fallbackValue;
      },
      set(key, value) {
        // 先同步更新内存，保证同一页面后续读取立即可见；再异步持久化到扩展存储。
        memoryCache[key] = value;
        void browser.storage.local.set({ [key]: value }).catch((error) => {
          console.warn(`[OverlayLex] 写入 browser.storage.local 失败: ${key}`, error);
        });
      },
    };

    // legacy UserScript 仍是唯一运行时实现；此时扩展存储桥已经准备完成。
    await import('../src/userscript/overlaylex.user.js');
  },
});
