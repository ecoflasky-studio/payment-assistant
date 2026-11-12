/**
 * 三语：简体中文（原文）/ Português (Brasil) / English。
 * - 代码里的界面文字写中文原文，包在 tr('…') 里；{0} {1} 是插入的值。
 * - 语言在启动时确定（跟随系统，设置里可改），之后不变：切换语言会重新加载页面，
 *   所以模块顶层的 tr() 也能拿到正确的语言。
 * - tx(s)：翻译运行时才知道的文字（服务端报错、识别提示），找不到就原样返回。
 */
export type Lang = 'zh' | 'pt' | 'en';
export const LANGS: { id: Lang; label: string }[] = [
  { id: 'zh', label: '简体中文' },
  { id: 'pt', label: 'Português' },
  { id: 'en', label: 'English' },
];
const KEY = 'zq-lang';

type Dict = Record<string, string>;
let dict: Dict | null = null;
let current: Lang = 'zh';

export function systemLang(langs: readonly string[] = typeof navigator !== 'undefined' ? navigator.languages ?? [navigator.language] : []): Lang {
  for (const l of langs) {
    const s = String(l || '').toLowerCase();
    if (s.startsWith('zh')) return 'zh';
    if (s.startsWith('pt')) return 'pt';
    if (s.startsWith('en')) return 'en';
  }
  return langs.length ? 'en' : 'zh';
}

/** 用户选的语言；'auto' = 跟随系统 */
export function savedLang(): Lang | 'auto' {
  try {
    const v = localStorage.getItem(KEY);
    if (v === 'zh' || v === 'pt' || v === 'en') return v;
  } catch {}
  return 'auto';
}

export function setLang(l: Lang | 'auto') {
  try {
    if (l === 'auto') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, l);
  } catch {}
  location.reload();
}

export const lang = () => current;

/** 启动时调用一次：确定语言（词典由 i18n-load.ts 加载，服务端打包不会带上词典） */
export function detectLang(): Lang {
  const s = savedLang();
  current = s === 'auto' ? systemLang() : s;
  if (typeof document !== 'undefined') document.documentElement.lang = current === 'zh' ? 'zh-CN' : current === 'pt' ? 'pt-BR' : 'en';
  return current;
}

/** 设定语言和词典（启动时由 i18n-load.ts 调用；测试也用它） */
export function setDict(l: Lang, d: Dict | null) {
  current = l;
  dict = d;
  patterns = null;
}

const fill = (s: string, args: unknown[]) => (args.length ? s.replace(/\{(\d+)\}/g, (m, i) => (Number(i) < args.length ? String(args[Number(i)]) : m)) : s);

// 葡语 / 英文的单数：「1 contas」→「1 conta」
const SINGULAR: Record<string, string> = {
  contas: 'conta', dias: 'dia', meses: 'mês', semanas: 'semana', leituras: 'leitura', linhas: 'linha', fornecedores: 'fornecedor', pagamentos: 'pagamento', imagens: 'imagem', anos: 'ano', parcelas: 'parcela', aparelhos: 'aparelho', vencidas: 'vencida', pagas: 'paga', erros: 'erro', conflitos: 'conflito', registros: 'registro', lançamentos: 'lançamento', itens: 'item', favorecidos: 'favorecido',
  bills: 'bill', days: 'day', months: 'month', weeks: 'week', scans: 'scan', rows: 'row', suppliers: 'supplier', payments: 'payment', images: 'image', years: 'year', installments: 'installment', devices: 'device', errors: 'error', conflicts: 'conflict', records: 'record', entries: 'entry', items: 'item', payees: 'payee',
};
const SING_RE = new RegExp(`(^|[^\\d.,])1 (${Object.keys(SINGULAR).join('|')})\\b`, 'g');
export const singular = (s: string) => (current === 'zh' ? s : s.replace(SING_RE, (_, pre, w) => `${pre}1 ${SINGULAR[w]}`));

/** 翻译源码里的固定文字 */
export function tr(zh: string, ...args: unknown[]): string {
  const out = fill((dict && dict[zh]) || zh, args);
  return args.length ? singular(out) : out;
}

let patterns: { re: RegExp; to: string }[] | null = null;
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 翻译运行时得到的文字（含 {n} 的词条按模式匹配）；找不到原样返回 */
export function tx(s: string | null | undefined): string {
  if (s == null) return '';
  const text = String(s);
  if (!dict || !text) return text;
  const hit = dict[text];
  if (hit) return hit;
  const done = (o: string) => singular(o);
  if (!/[一-鿿]/.test(text)) return text;
  if (!patterns) {
    patterns = Object.keys(dict)
      .filter((k) => /\{\d+\}/.test(k))
      .sort((a, b) => b.replace(/\{\d+\}/g, '').length - a.replace(/\{\d+\}/g, '').length)
      .map((k) => ({ re: new RegExp('^' + k.split(/(\{\d+\})/).map((p) => (/^\{\d+\}$/.test(p) ? '([\\s\\S]*?)' : esc(p))).join('') + '$'), to: dict![k], order: [...k.matchAll(/\{(\d+)\}/g)].map((m) => Number(m[1])) }))
      .map(({ re, to, order }) => ({ re, to: to.replace(/\{(\d+)\}/g, (_, i) => `{@${order.indexOf(Number(i))}}`) }));
  }
  for (const p of patterns) {
    const m = p.re.exec(text);
    if (m) return done(p.to.replace(/\{@(-?\d+)\}/g, (_, i) => (Number(i) >= 0 ? tx(m[Number(i) + 1]) : '')));
  }
  // 多句拼起来的提示：按句号 / 分号拆开再试
  const parts = text.split(/(?<=[。；！？])/);
  if (parts.length > 1) {
    const out = parts.map((p) => tx(p));
    if (out.some((o, i) => o !== parts[i])) return out.join(' ');
  }
  return text;
}

const MONTHS: Record<Lang, string[]> = {
  zh: [],
  pt: ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'],
  en: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
};
/** 月份简称：10月 / out / Oct */
export const monthShort = (m: number) => (current === 'zh' ? `${m}月` : MONTHS[current][m - 1] ?? String(m));
