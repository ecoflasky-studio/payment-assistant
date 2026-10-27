/** 生成商店截图用的演示数据（去掉「示例」字样）：npx vite-node scripts/store-data.ts <today> */
import { writeFileSync } from 'node:fs';
import { makeSampleData } from '../src/sample';
import { makeBackup } from '../src/lib/backup';

const today = process.argv[2] || new Date().toISOString().slice(0, 10);
const d = makeSampleData(today);
const re = (s: string) => s.replace(/^示例 · /, '').replace(/示例公司/, 'Minha Loja');
const id = (s: string) => s.replace(/^sample-/, 'demo-');
const fix = <T extends Record<string, any>>(o: T): T => JSON.parse(JSON.stringify(o).replace(/"sample-/g, '"demo-').replace(/示例 · /g, '').replace(/示例数据/g, '').replace(/示例公司/g, 'Minha Loja'));
const bills = d.bills.map((b, i) => fix({ ...b, id: id(b.id), tags: i % 4 === 0 ? ['店铺A'] : i % 5 === 1 ? ['年货'] : [] }));
const merchants = d.merchants.map((m) => fix({ ...m, id: id(m.id), name: re(m.name) }));
const accounts = d.accounts.map((a) => fix(a));
writeFileSync('store/demo-backup.json', JSON.stringify(makeBackup({ bills, merchants, accounts } as any, null), null, 1));
console.log(`store/demo-backup.json: ${bills.length} bills`);
