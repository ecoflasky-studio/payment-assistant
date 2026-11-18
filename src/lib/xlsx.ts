/** 极简 .xlsx 读写（只处理批量导入要用的部分：文字、数字、日期） */
import { unzipSync, zipSync, strToU8, strFromU8 } from 'fflate';

export type Cell = string | number | null | undefined;
export interface SheetIn {
  name: string;
  rows: Cell[][];
  /** 每列宽度（字符数） */
  widths?: number[];
  /** 这些列（从 0 开始）设为「文本」格式，保留单号前导零 */
  textCols?: number[];
  /** 第一行加粗并冻结 */
  header?: boolean;
}

const esc = (s: string) =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    // XML 1.0 不允许的控制字符
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');

const unesc = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e: string) => {
    const k = e.toLowerCase();
    if (k === 'amp') return '&';
    if (k === 'lt') return '<';
    if (k === 'gt') return '>';
    if (k === 'quot') return '"';
    if (k === 'apos') return "'";
    const code = k.startsWith('#x') ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
    return Number.isFinite(code) ? String.fromCodePoint(code) : '';
  });

export function colName(i: number): string {
  let s = '';
  let n = i + 1;
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

export function colIndex(ref: string): number {
  const letters = /^[A-Z]+/i.exec(ref)?.[0].toUpperCase() ?? '';
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/* ---------------- 写 ---------------- */

function sheetXml(s: SheetIn): string {
  const text = new Set(s.textCols ?? []);
  const cols = s.widths?.length
    ? `<cols>${s.widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"${text.has(i) ? ' style="2"' : ''}/>`).join('')}</cols>`
    : '';
  const pane = s.header ? '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' : '';
  const rows = s.rows
    .map((r, ri) => {
      const cells = r
        .map((v, ci) => {
          if (v === null || v === undefined || v === '') return '';
          const ref = `${colName(ci)}${ri + 1}`;
          const style = s.header && ri === 0 ? ' s="1"' : text.has(ci) ? ' s="2"' : '';
          if (typeof v === 'number' && Number.isFinite(v)) return `<c r="${ref}"${style}><v>${v}</v></c>`;
          return `<c r="${ref}"${style} t="inlineStr"><is><t xml:space="preserve">${esc(String(v))}</t></is></c>`;
        })
        .join('');
      return `<row r="${ri + 1}">${cells}</row>`;
    })
    .join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${pane}${cols}<sheetData>${rows}</sheetData></worksheet>`;
}

/** 生成 .xlsx 文件内容 */
export function writeXlsx(sheets: SheetIn[]): Uint8Array {
  const safeName = (n: string, i: number) => esc(n.replace(/[\\/?*[\]:]/g, ' ').slice(0, 31) || `Sheet${i + 1}`);
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets
        .map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`)
        .join('')}</Types>`,
    ),
    '_rels/.rels': strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    ),
    'xl/workbook.xml': strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets
        .map((s, i) => `<sheet name="${safeName(s.name, i)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
        .join('')}</sheets></workbook>`,
    ),
    'xl/_rels/workbook.xml.rels': strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets
        .map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`)
        .join('')}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    ),
    // 0 默认；1 表头加粗 + 浅底色；2 文本格式（@）
    'xl/styles.xml': strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE8F0FE"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/><xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs></styleSheet>',
    ),
  };
  sheets.forEach((s, i) => (files[`xl/worksheets/sheet${i + 1}.xml`] = strToU8(sheetXml(s))));
  return zipSync(files, { level: 6 });
}

/* ---------------- 读 ---------------- */

/** Excel 内置的日期格式编号 */
const DATE_FMT_IDS = new Set([14, 15, 16, 17, 22, 27, 30, 36, 45, 46, 47, 50, 57]);

function isDateFormat(code: string): boolean {
  // 去掉引号里的文字、[颜色]/[$-416] 之类、转义字符，再看有没有 d / y（或只有月份 m、没有时分秒）
  const c = code.replace(/"[^"]*"/g, '').replace(/\[[^\]]*\]/g, '').replace(/\\./g, '').toLowerCase();
  if (/[dy]/.test(c)) return true;
  return /m/.test(c) && !/[hs]/.test(c);
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Excel 序列日期 → DD/MM/YYYY（1900 日期系统；date1904 时加 1462 天） */
export function serialToBR(serial: number, date1904 = false): string {
  const days = Math.floor(serial + (date1904 ? 1462 : 0));
  const d = new Date(Date.UTC(1899, 11, 30) + days * 86400000);
  return `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`;
}

/** 数字转成巴西写法（逗号小数，不加千分位），整数原样 */
function numToText(n: number): string {
  if (Number.isInteger(n)) return String(n);
  const r = Math.round(n * 1e6) / 1e6;
  return String(r).replace('.', ',');
}

const attr = (tag: string, name: string) => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];

function textOf(xml: string): string {
  // 只取 <t>，跳过注音 <rPh>
  const noPh = xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '');
  let out = '';
  for (const m of noPh.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>|<t\b[^>]*\/>/g)) out += unesc(m[1] ?? '');
  return out;
}

export class XlsxError extends Error {}

/** 读取第一个工作表为二维文字数组（空行去掉，日期转成 DD/MM/YYYY） */
export function readXlsx(data: Uint8Array): { sheet: string; rows: string[][] } {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(data, { filter: (f) => (f.name.startsWith('xl/') && f.name.endsWith('.xml')) || f.name.endsWith('.rels') });
  } catch {
    throw new XlsxError('不是有效的 .xlsx 文件');
  }
  const read = (p: string) => (files[p] ? strFromU8(files[p]) : '');
  const wb = read('xl/workbook.xml');
  if (!wb) throw new XlsxError('不是有效的 .xlsx 文件');
  const date1904 = /<workbookPr\b[^>]*date1904="(1|true)"/.test(wb);
  const firstSheet = /<sheet\b[^>]*>/.exec(wb)?.[0] ?? '';
  const sheetName = unesc(attr(firstSheet, 'name') ?? '');
  const rid = attr(firstSheet, 'r:id');
  let target = 'worksheets/sheet1.xml';
  if (rid) {
    const rels = read('xl/_rels/workbook.xml.rels');
    for (const m of rels.matchAll(/<Relationship\b[^>]*>/g)) if (attr(m[0], 'Id') === rid) target = attr(m[0], 'Target') ?? target;
  }
  const path = target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`;
  const sheet = read(path) || read('xl/worksheets/sheet1.xml');
  if (!sheet) throw new XlsxError('表格里没有工作表');

  const shared: string[] = [];
  const ss = read('xl/sharedStrings.xml');
  for (const m of ss.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>|<si\b[^>]*\/>/g)) shared.push(textOf(m[1] ?? ''));

  // 样式：哪些 s 编号是日期格式
  const styles = read('xl/styles.xml');
  const custom = new Map<number, string>();
  for (const m of styles.matchAll(/<numFmt\b[^>]*>/g)) {
    const id = Number(attr(m[0], 'numFmtId'));
    const code = unesc(attr(m[0], 'formatCode') ?? '');
    if (Number.isFinite(id)) custom.set(id, code);
  }
  const dateStyle: boolean[] = [];
  const xfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(styles)?.[1] ?? '';
  for (const m of xfs.matchAll(/<xf\b[^>]*>/g)) {
    const id = Number(attr(m[0], 'numFmtId') ?? 0);
    dateStyle.push(DATE_FMT_IDS.has(id) || (custom.has(id) && isDateFormat(custom.get(id)!)));
  }

  const rows: string[][] = [];
  for (const rm of sheet.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>|<row\b[^>]*\/>/g)) {
    const rowNo = Number(attr(rm[0].slice(0, rm[0].indexOf('>') + 1), 'r'));
    const row: string[] = [];
    let next = 0;
    for (const cm of (rm[1] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const head = cm[1];
      const body = cm[2] ?? '';
      const ref = attr(head, 'r');
      const ci = ref ? colIndex(ref) : next;
      next = ci + 1;
      const t = attr(head, 't') ?? 'n';
      const s = Number(attr(head, 's') ?? 0);
      const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
      let out = '';
      if (t === 's') out = shared[Number(v)] ?? '';
      else if (t === 'inlineStr') out = textOf(/<is>([\s\S]*?)<\/is>/.exec(body)?.[1] ?? '');
      else if (t === 'str') out = unesc(v ?? '');
      else if (t === 'b') out = v === '1' ? 'TRUE' : 'FALSE';
      else if (t === 'e') out = '';
      else if (v !== undefined && v !== '') {
        const n = Number(v);
        out = !Number.isFinite(n) ? unesc(v) : dateStyle[s] ? serialToBR(n, date1904) : numToText(n);
      }
      row[ci] = out.trim();
    }
    for (let i = 0; i < row.length; i++) if (row[i] === undefined) row[i] = '';
    if (row.some((x) => x !== '')) {
      // 按行号保持顺序（极少数文件行号乱序）
      (row as string[] & { _r?: number })._r = Number.isFinite(rowNo) ? rowNo : rows.length + 1;
      rows.push(row);
    }
  }
  rows.sort((a, b) => ((a as any)._r ?? 0) - ((b as any)._r ?? 0));
  return { sheet: sheetName, rows: rows.map((r) => [...r]) };
}

/** 文件头是不是 zip（xlsx 本质是 zip） */
export const looksLikeZip = (d: Uint8Array) => d.length > 4 && d[0] === 0x50 && d[1] === 0x4b;
