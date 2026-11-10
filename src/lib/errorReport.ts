/**
 * 错误报告：只发「哪里出错」，不发账单内容。
 * - 报错文字里的数字（金额、单号、日期）、邮箱、引号里的内容都会被抹掉；
 * - 调用栈只留文件名和行号；
 * - 同一错误一次会话只报一次，每次会话最多 5 条；设置里可以关闭。
 */
export const APP_VERSION = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev';
export const BUILD_ID = typeof __BUILD_ID__ === 'string' ? __BUILD_ID__ : 'dev';

export interface ErrorReport {
  message: string;
  stack: string;
  where: string;
  version: string;
  platform: string;
}

/** 抹掉可能是个人或账单信息的内容 */
export function scrub(text: string): string {
  return String(text ?? '')
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '<email>')
    .replace(/(["'`“”‘’«])(?:(?!\1).){1,200}\1/g, '"…"')
    .replace(/R\$\s*[\d.,]+/gi, '<money>')
    .replace(/\d[\d.,/:-]{1,}\d|\d{2,}/g, '#')
    .replace(/[^\x20-\x7e一-鿿　-〿＀-￯\n]/g, '')
    .slice(0, 300);
}

/** 调用栈只留「函数 文件:行:列」，去掉网址前缀和查询串 */
export function cleanStack(stack: string | undefined): string {
  return String(stack ?? '')
    .split('\n')
    .slice(0, 8)
    .map((l) =>
      l
        .trim()
        .replace(/\(?(?:https?|capacitor|file|blob):\/\/[^\s)]*\/([^/\s)?#]+)(?:\?[^\s):]*)?(:\d+:\d+)?\)?/g, '$1$2')
        .slice(0, 160),
    )
    .filter(Boolean)
    .join('\n');
}

export function buildReport(err: unknown, where: string, platform: string): ErrorReport {
  const e = err instanceof Error ? err : new Error(typeof err === 'string' ? err : 'unknown');
  return { message: scrub(`${e.name}: ${e.message}`), stack: cleanStack(e.stack), where: where.replace(/[^\w/:-]/g, '').slice(0, 40), version: `${APP_VERSION}+${BUILD_ID}`, platform };
}

type Sender = (r: ErrorReport) => Promise<unknown>;
let sender: Sender | null = null;
let enabled = true;
const seen = new Set<string>();
let count = 0;
let where = () => '';
let platformName = 'web';

export function configureErrorReports(opts: { send: Sender | null; enabled: boolean; where: () => string; platform: string }) {
  sender = opts.send;
  enabled = opts.enabled;
  where = opts.where;
  platformName = opts.platform;
}

/** 上报一个错误（不会抛出） */
export function reportError(err: unknown) {
  try {
    if (!enabled || !sender || count >= 5) return;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
    const r = buildReport(err, where(), platformName);
    // 浏览器扩展、网络抖动等不是我们的错误
    if (/ResizeObserver loop|Script error|chrome-extension|moz-extension|Load failed|Failed to fetch|NetworkError|AbortError/i.test(r.message + r.stack)) return;
    const key = r.message + '|' + r.stack.split('\n')[1];
    if (seen.has(key)) return;
    seen.add(key);
    count++;
    void sender(r).catch(() => {});
  } catch {}
}

let installed = false;
export function installGlobalHandlers() {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  window.addEventListener('error', (e) => reportError(e.error ?? e.message));
  window.addEventListener('unhandledrejection', (e) => reportError(e.reason));
}
