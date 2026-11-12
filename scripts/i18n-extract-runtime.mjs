/** 提取运行时才显示的中文（识别提示、服务端报错等）作为 tx() 的词条 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
const ts = createRequire(import.meta.url)(process.env.TS_JS_API || 'typescript');
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const FILES = ['src/lib/importTable.ts', 'src/lib/ocr/protocol.ts', 'src/lib/ocr/learn.ts', 'src/lib/ocr/rows.ts', 'src/lib/ocr/enrich.ts', 'src/lib/ocr/pdfText.ts', 'src/lib/ocr/evaluate.ts', 'src/lib/statement.ts', 'src/lib/boleto.ts', 'supabase/saas.mjs', 'supabase/stores.mjs', 'supabase/entry.mjs', 'server/core.mjs', 'shared/plans.mjs'];
const CJK = /[一-鿿]/;
const keys = new Set();
for (const rel of FILES) {
  const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const sf = ts.createSourceFile(rel, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const v = (n) => {
    if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && CJK.test(n.text)) keys.add(n.text);
    else if (ts.isTemplateExpression(n)) {
      let k = n.head.text;
      n.templateSpans.forEach((s, i) => (k += `{${i}}` + s.literal.text));
      if (CJK.test(k)) keys.add(k);
      n.templateSpans.forEach((s) => ts.forEachChild(s.expression, v), v(n.head));
      n.templateSpans.forEach((s) => v(s.expression));
      return;
    }
    ts.forEachChild(n, v);
  };
  v(sf);
}
// 去掉明显不是给人看的（单字、表头同义词）
const out = [...keys].filter((k) => k.replace(/\{\d+\}/g, '').length >= 2 && !k.startsWith('[') && k.length < 300).sort();
fs.writeFileSync(path.join(ROOT, 'scripts/i18n-runtime-keys.json'), JSON.stringify(out, null, 1));
console.log(out.length, out.join('').length);
