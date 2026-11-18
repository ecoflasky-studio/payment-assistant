import { describe, it, expect } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { readXlsx, writeXlsx, serialToBR, colName, colIndex, looksLikeZip } from '../src/lib/xlsx';
import { planImport, guessField } from '../src/lib/importTable';
import { buildTemplate } from '../src/pages/ImportTable';
import type { Merchant, PaymentAccount } from '../src/lib/types';

/** 模拟 Excel 自己存的文件：sharedStrings + 日期样式 + 数字单元格 */
function excelLike(): Uint8Array {
  const sheet = `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>
<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c><c r="D1" t="s"><v>3</v></c><c r="E1" t="s"><v>4</v></c></row>
<row r="3"><c r="A3" t="s"><v>5</v></c><c r="B3" s="2"><v>42</v></c><c r="C3" s="1"><v>46266</v></c><c r="D3" s="3"><v>46296</v></c><c r="E3"><v>1234.5</v></c></row>
<row r="4"><c r="A4" t="inlineStr"><is><t>Bras &amp; Cia</t></is></c><c r="B4" t="s"><v>6</v></c><c r="C4" t="str"><f>TODAY()</f><v>05/09/2026</v></c><c r="D4" t="s"><v>7</v></c><c r="E4" t="s"><v>8</v></c></row>
</sheetData></worksheet>`;
  const ss = `<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>Fornecedor</t></si><si><t>Nº do pedido</t></si><si><r><t>Data de </t></r><r><t>emissão</t></r><rPh><t>ignored</t></rPh></si><si><t>Vencimento</t></si><si><t>Valor</t></si><si><t>Loja Exemplo</t></si><si><t>0099</t></si><si><t>05/10/2026</t></si><si><t>R$ 1.000,00</t></si></sst>`;
  const styles = `<?xml version="1.0"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="dd/mm/yyyy;@"/></numFmts><cellXfs count="4"><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="49"/><xf numFmtId="164"/></cellXfs></styleSheet>`;
  const wb = `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Planilha1" sheetId="1" r:id="rId3"/></sheets></workbook>`;
  const rels = `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId3" Type="x" Target="worksheets/planilha.xml"/></Relationships>`;
  return zipSync({ 'xl/workbook.xml': strToU8(wb), 'xl/_rels/workbook.xml.rels': strToU8(rels), 'xl/worksheets/planilha.xml': strToU8(sheet), 'xl/sharedStrings.xml': strToU8(ss), 'xl/styles.xml': strToU8(styles) });
}

const merchants: Merchant[] = [{ id: 'm1', name: 'Loja Exemplo', aliases: [], defaultAccountId: null, active: true, createdAt: '', updatedAt: '' }];
const accounts: PaymentAccount[] = [{ id: 'a1', label: 'PIX 公司主账户', type: 'pix', active: true, createdAt: '', updatedAt: '' } as PaymentAccount];
let n = 0;
const opts = { merchants, accounts, bills: [], settings: { defaultReminderDays: 3, defaultAccountId: 'a1' }, today: '2026-09-20', uuid: () => `x-${++n}`, now: '2026-09-20T00:00:00.000Z' } as never;

describe('xlsx', () => {
  it('列名换算', () => {
    expect(colName(0)).toBe('A');
    expect(colName(26)).toBe('AA');
    expect(colIndex('AB12')).toBe(27);
    expect(serialToBR(46266)).toBe('01/09/2026');
    expect(serialToBR(44804, true)).toBe('01/09/2026');
  });

  it('读 Excel 存的文件：共享字符串、富文本、日期样式、空行、公式结果', () => {
    const r = readXlsx(excelLike());
    expect(r.sheet).toBe('Planilha1');
    expect(r.rows).toEqual([
      ['Fornecedor', 'Nº do pedido', 'Data de emissão', 'Vencimento', 'Valor'],
      ['Loja Exemplo', '42', '01/09/2026', '01/10/2026', '1234,5'],
      ['Bras & Cia', '0099', '05/09/2026', '05/10/2026', 'R$ 1.000,00'],
    ]);
    const p = planImport(r.rows, opts);
    expect(p.okCount).toBe(2);
    expect(p.rows[0].bill?.totalCents).toBe(123450);
    expect(p.rows[0].bill?.dueDate).toBe('2026-10-01');
    expect(p.rows[1].bill?.orderNumber).toBe('0099');
    expect(p.newMerchants).toEqual(['Bras & Cia']);
  });

  it('写出再读回一致；模板能直接导入', () => {
    const data = writeXlsx([{ name: 'A/B', rows: [['x', 1.5, null, '<&>'], [], ['0042']], header: true, textCols: [0] }]);
    expect(looksLikeZip(data)).toBe(true);
    expect(readXlsx(data).rows).toEqual([['x', '1,5', '', '<&>'], ['0042']]);
    const tpl = readXlsx(buildTemplate('2026-09-20', 'PIX 公司主账户'));
    expect(tpl.rows[0].map(guessField)).toEqual(['merchant', 'orderNumber', 'billDate', 'dueDate', 'amount', 'account', 'category', 'paidDate', 'notes']);
    const p = planImport(tpl.rows, opts);
    expect(p.okCount).toBe(2);
    expect(p.rows[0].bill?.orderNumber).toBe('0042');
    expect(p.rows[1].bill?.kind).toBe('expense');
    expect(p.rows[1].bill?.category).toBe('power');
    expect(p.rows[1].bill?.totalCents).toBe(21540);
  });

  it('不是 xlsx 时报错', () => {
    expect(() => readXlsx(strToU8('hello'))).toThrow();
  });

  it('付款日期列：日期 = 那天付清，「已付」= 按到期日，金额列不误认', () => {
    expect(guessField('已付(R$)')).toBe('skip');
    expect(guessField('Pago (R$)')).toBe('skip');
    expect(guessField('Data de quitação')).toBe('paidDate');
    expect(guessField('Paid-off date')).toBe('paidDate');
    const p = planImport(
      [
        ['商家', '开单日期', '到期日期', '金额', '付款日期'],
        ['Loja Exemplo', '01/09/2026', '10/09/2026', '100,00', '08/09/2026'],
        ['Loja Exemplo', '01/09/2026', '12/09/2026', '50,00', '已付'],
        ['Loja Exemplo', '01/09/2026', '14/09/2026', '70,00', ''],
        ['Loja Exemplo', '01/09/2026', '16/09/2026', '70,00', '30/12/2026'],
      ],
      opts,
    );
    expect(p.rows[0].bill?.payments?.[0]).toMatchObject({ date: '2026-09-08', cents: 10000 });
    expect(p.rows[0].bill?.paidAt?.slice(0, 10)).toBe('2026-09-08');
    expect(p.rows[1].bill?.payments?.[0].date).toBe('2026-09-12');
    expect(p.rows[2].bill?.paidAt).toBeNull();
    expect(p.rows[3].issues[0]).toContain('今天之后');
  });

  it('分类可用葡语名', () => {
    const p = planImport([['Fornecedor', 'Vencimento', 'Valor', 'Categoria'], ['Sabesp', '10/10/2026', '80,00', 'Água']], opts);
    expect(p.rows[0].bill?.category).toBe('water');
  });
});
