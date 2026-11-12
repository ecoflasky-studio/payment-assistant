/** 启动时加载当前语言的词典（只加载一种，中文不用加载） */
import { detectLang, setDict } from './i18n';

export async function initI18n() {
  const l = detectLang();
  if (l === 'zh') return l;
  try {
    const d = l === 'pt' ? await import('./locales/pt.json') : await import('./locales/en.json');
    setDict(l, d.default as Record<string, string>);
  } catch {
    setDict(l, null);
  }
  return l;
}
