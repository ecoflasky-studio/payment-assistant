/**
 * 一次性代码转换：把界面里的中文字符串包进 tr()。
 * node scripts/i18n-wrap.mjs [--dry] → 输出每个文件改了几处，以及所有词条（scripts/i18n-keys.json）
 */
import { createRequire } from 'node:module';
const ts = createRequire(import.meta.url)(process.env.TS_JS_API || 'typescript');
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const DRY = process.argv.includes('--dry');
const CJK = /[\u4e00-\u9fff\u3000-\u303f\uff01-\uff5e]/;
const SKIP_FILES = [
  'src/i18n.ts', 'src/lib/errorReport.ts', 'src/lib/importTable.ts', 'src/lib/types.ts',
  'src/lib/ocr/protocol.ts', 'src/lib/ocr/learn.ts', 'src/lib/ocr/rows.ts', 'src/lib/ocr/enrich.ts', 'src/lib/ocr/pdfText.ts', 'src/lib/ocr/evaluate.ts', 'src/lib/ocr/prompt.ts',
  'src/lib/statement.ts', 'src/lib/boleto.ts', 'src/env.d.ts',
];
const NO_ARG_METHODS = new Set(['includes', 'startsWith', 'endsWith', 'indexOf', 'lastIndexOf', 'split', 'replace', 'replaceAll', 'match', 'test', 'has', 'get', 'delete', 'getItem', 'setItem', 'removeItem', 'localeCompare', 'querySelector', 'querySelectorAll', 'getElementById']);
const NO_JSX_ATTR = new Set(['key', 'className', 'id', 'htmlFor', 'type', 'name', 'inputMode', 'autoComplete', 'role', 'href', 'src', 'rel', 'target', 'data-tour', 'lang', 'accept', 'capture', 'pattern', 'value', 'defaultValue']);

const files = [];
(function walk(d) {
  for (const f of fs.readdirSync(d)) {
    const p = path.join(d, f);
    if (fs.statSync(p).isDirectory()) walk(p);
    else if (/\.(ts|tsx)$/.test(f)) files.push(p);
  }
})(path.join(ROOT, 'src'));

const keys = new Map(); // key → [file]
const report = [];
const lit = (s) => JSON.stringify(s).replace(/^"|"$/g, '').replace(/'/g, "\\'").replace(/\\"/g, '"');
const q = (s) => `'${lit(s)}'`;
const decode = (s) => s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");

function excluded(node) {
  const p = node.parent;
  if (!p) return true;
  if (ts.isImportDeclaration(p) || ts.isExportDeclaration(p) || ts.isLiteralTypeNode(p) || ts.isExternalModuleReference(p)) return true;
  if ((ts.isPropertyAssignment(p) || ts.isPropertyDeclaration(p) || ts.isPropertySignature(p) || ts.isMethodDeclaration(p) || ts.isEnumMember(p)) && p.name === node) return true;
  if (ts.isComputedPropertyName(p) || (ts.isElementAccessExpression(p) && p.argumentExpression === node)) return true;
  if (ts.isCaseClause(p)) return true;
  if (ts.isBinaryExpression(p) && [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken, ts.SyntaxKind.InKeyword].includes(p.operatorToken.kind)) return true;
  if (ts.isCallExpression(p) && p.arguments.includes(node)) {
    const c = p.expression;
    const name = ts.isPropertyAccessExpression(c) ? c.name.text : ts.isIdentifier(c) ? c.text : '';
    if (NO_ARG_METHODS.has(name) || name === 'tr' || name === 'tx' || name === 'RegExp') return true;
    if (ts.isPropertyAccessExpression(c) && ts.isIdentifier(c.expression) && c.expression.text === 'console') return true;
  }
  if (ts.isNewExpression(p) && ts.isIdentifier(p.expression) && p.expression.text === 'RegExp') return true;
  if (ts.isTaggedTemplateExpression(p)) return true;
  if (ts.isJsxAttribute(p) && NO_JSX_ATTR.has(p.name.getText())) return true;
  return false;
}

for (const file of files) {
  const rel = path.relative(ROOT, file).replace(/\\/g, '/');
  if (SKIP_FILES.includes(rel)) continue;
  const src = fs.readFileSync(file, 'utf8');
  if (!CJK.test(src)) continue;
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const edits = [];
  const add = (start, end, text, key) => {
    edits.push({ start, end, text });
    if (!keys.has(key)) keys.set(key, new Set());
    keys.get(key).add(rel);
  };
  const visit = (node) => {
    if (ts.isJsxText(node) && CJK.test(node.text)) {
      const raw = node.getFullText();
      const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(raw);
      const body = decode(m[2].replace(/\s*\n\s*/g, ' '));
      const pre = m[1].includes('\n') ? m[1] : m[1];
      const post = m[3];
      add(node.getFullStart(), node.getEnd(), `${pre}{tr(${q(body)})}${post}`, body);
      return;
    }
    if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && CJK.test(node.text) && !excluded(node)) {
      const inAttr = ts.isJsxAttribute(node.parent);
      const text = `tr(${q(node.text)})`;
      add(node.getStart(), node.getEnd(), inAttr ? `{${text}}` : text, node.text);
      return;
    }
    if (ts.isTemplateExpression(node) && !excluded(node)) {
      const parts = [node.head.text, ...node.templateSpans.map((s) => s.literal.text)];
      if (parts.some((p) => CJK.test(p))) {
        let key = node.head.text;
        const args = [];
        node.templateSpans.forEach((s, i) => {
          key += `{${i}}` + s.literal.text;
          // 递归处理插值里的中文
          args.push(transformInner(s.expression));
        });
        add(node.getStart(), node.getEnd(), `tr(${q(key)}, ${args.join(', ')})`, key);
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  // 插值表达式里还可能有中文：单独处理成文本
  function transformInner(expr) {
    const inner = [];
    const sub = (n) => {
      if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && CJK.test(n.text) && !excluded(n)) {
        inner.push({ s: n.getStart() - expr.getStart(), e: n.getEnd() - expr.getStart(), t: `tr(${q(n.text)})`, k: n.text });
        return;
      }
      if (ts.isTemplateExpression(n) && !excluded(n)) {
        const parts = [n.head.text, ...n.templateSpans.map((s) => s.literal.text)];
        if (parts.some((p) => CJK.test(p))) {
          let key = n.head.text;
          const args = [];
          n.templateSpans.forEach((s, i) => {
            key += `{${i}}` + s.literal.text;
            args.push(transformInner(s.expression));
          });
          inner.push({ s: n.getStart() - expr.getStart(), e: n.getEnd() - expr.getStart(), t: `tr(${q(key)}, ${args.join(', ')})`, k: key });
          return;
        }
      }
      if (ts.isJsxText(n) && CJK.test(n.text)) {
        const raw = n.getFullText();
        const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(raw);
        const body = decode(m[2].replace(/\s*\n\s*/g, ' '));
        inner.push({ s: n.getFullStart() - expr.getStart(), e: n.getEnd() - expr.getStart(), t: `${m[1]}{tr(${q(body)})}${m[3]}`, k: body });
        return;
      }
      ts.forEachChild(n, sub);
    };
    sub(expr);
    let text = expr.getText();
    for (const it of inner.sort((a, b) => b.s - a.s)) {
      text = text.slice(0, it.s) + it.t + text.slice(it.e);
      if (!keys.has(it.k)) keys.set(it.k, new Set());
      keys.get(it.k).add(rel);
    }
    return text;
  }
  visit(sf);
  if (!edits.length) continue;
  let out = src;
  for (const e of edits.sort((a, b) => b.start - a.start)) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  // 加 import
  const relImp = path.relative(path.dirname(file), path.join(ROOT, 'src/i18n')).replace(/\\/g, '/');
  const imp = `import { tr } from '${relImp.startsWith('.') ? relImp : './' + relImp}';\n`;
  if (!/import \{[^}]*\btr\b[^}]*\} from '[^']*i18n'/.test(out)) {
    // 放在第一个 import 之前（保留文件头注释）
    const firstImport = out.search(/^import /m);
    out = firstImport >= 0 ? out.slice(0, firstImport) + imp + out.slice(firstImport) : imp + out;
  }
  report.push(`${String(edits.length).padStart(4)} ${rel}`);
  if (!DRY) fs.writeFileSync(file, out);
}
console.log(report.join('\n'));
const all = [...keys.keys()].sort();
fs.writeFileSync(path.join(ROOT, 'scripts/i18n-keys.json'), JSON.stringify(Object.fromEntries([...keys].map(([k, v]) => [k, [...v]])), null, 1));
console.log('keys', all.length, 'chars', all.join('').length);
