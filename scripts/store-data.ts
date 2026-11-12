/** 生成商店截图用的演示数据（去掉「示例」字样），每种语言一份：npx vite-node scripts/store-data.ts <today> */
import { writeFileSync } from 'node:fs';
import { setDict, type Lang } from '../src/i18n';
import pt from '../src/locales/pt.json';
import { makeSampleData } from '../src/sample';
import { makeBackup } from '../src/lib/backup';
import en from '../src/locales/en.json';

const today = process.argv[2] || new Date().toISOString().slice(0, 10);
const PREFIX: Record<Lang, RegExp> = { zh: /示例 · /g, pt: /Exemplo · /g, en: /Sample · /g };
const COMPANY: Record<Lang, [RegExp, string]> = { zh: [/示例公司/g, 'Minha Loja'], pt: [/Empresa Exemplo/g, 'Minha Loja'], en: [/Sample Company/g, 'My Store'] };
const TAGS: Record<Lang, [string, string]> = { zh: ['店铺A', '年货'], pt: ['Loja A', 'Fim de ano'], en: ['Store A', 'Holiday'] };

for (const l of ['zh', 'pt', 'en'] as Lang[]) {
  setDict(l, l === 'zh' ? null : ((l === 'pt' ? pt : en) as Record<string, string>));
  const d = makeSampleData(today);
  const fix = <T,>(o: T): T => JSON.parse(JSON.stringify(o).replace(/"sample-/g, '"demo-').replace(PREFIX[l], '').replace(COMPANY[l][0], COMPANY[l][1]));
  const bills = d.bills.map((b: any, i: number) => fix({ ...b, tags: i % 4 === 0 ? [TAGS[l][0]] : i % 5 === 1 ? [TAGS[l][1]] : [] }));
  const merchants = d.merchants.map((m: any) => fix(m));
  const accounts = d.accounts.map((a: any) => fix(a));
  const out = JSON.stringify(makeBackup({ bills, merchants, accounts } as any, null), null, 1);
  writeFileSync(`store/demo-backup-${l}.json`, out);
  if (l === 'zh') writeFileSync('store/demo-backup.json', out);
  console.log(`store/demo-backup-${l}.json: ${bills.length} bills`);
}
