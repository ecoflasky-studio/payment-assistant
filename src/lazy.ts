import { lazy, type ComponentType } from 'react';

const KEY = 'zq-chunk-reload';

/**
 * 按需加载页面。新版本上线后旧页面再去取已删除的旧文件会失败：这时整页刷新一次换到新版本
 * （用 sessionStorage 防止反复刷新）。
 */
export function lazyPage<M extends Record<string, unknown>, K extends keyof M>(load: () => Promise<M>, name: K) {
  return lazy(async () => {
    try {
      const m = await load();
      try {
        sessionStorage.removeItem(KEY);
      } catch {}
      return { default: m[name] as unknown as ComponentType<any> };
    } catch (e) {
      let tried = false;
      try {
        tried = sessionStorage.getItem(KEY) === '1';
        if (!tried) sessionStorage.setItem(KEY, '1');
      } catch {
        tried = true;
      }
      if (!tried && navigator.onLine !== false) {
        location.reload();
        await new Promise(() => {});
      }
      throw e;
    }
  }) as unknown as M[K];
}

/** 空闲时预取常用页面，第一次点开不用等 */
export function prefetch(loads: (() => Promise<unknown>)[]) {
  const run = () => loads.forEach((l) => l().catch(() => {}));
  const ric = (globalThis as any).requestIdleCallback as ((cb: () => void, o?: object) => void) | undefined;
  if (ric) ric(run, { timeout: 4000 });
  else setTimeout(run, 2500);
}
