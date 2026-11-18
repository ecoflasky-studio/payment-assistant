import { tr, tx } from '../i18n';
import { useMemo, useState } from 'react';
import { useStore } from '../store';
import { useFeedback } from '../ui/feedback';
import { FIELD_LABEL, IMPORT_TEMPLATE, planImport, type Field, type ImportPlan } from '../lib/importTable';
import { formatBRL } from '../lib/money';
import { formatBR, addDays } from '../lib/dates';
import { uuid, nowISO } from '../lib/ids';
import { saveFile } from '../lib/platform';
import { readXlsx, writeXlsx, looksLikeZip, XlsxError } from '../lib/xlsx';
import { EXPENSE_CATEGORIES } from '../lib/expense';
import { IUpload, IDownload, ICheck, IX, IFile } from '../ui/icons';
import type { Merchant } from '../lib/types';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** Excel 导入模板：第一个表填账单，第二个表是填写说明 */
export function buildTemplate(today: string, accountLabel = ''): Uint8Array {
  const head = [tr('商家'), tr('单号'), tr('开单日期'), tr('到期日期'), tr('金额'), tr('付款账号'), tr('分类'), tr('付款日期'), tr('备注')];
  const power = EXPENSE_CATEGORIES.find((c) => c.id === 'power')!;
  const rows = [
    head,
    ['Loja Exemplo', '0042', formatBR(today), formatBR(addDays(today, 30)), 1234.56, accountLabel, '', '', tr('示例行（可删除）')],
    ['Enel', '', formatBR(today), formatBR(addDays(today, 10)), 215.4, accountLabel, power.label, '', tr('示例行（可删除）')],
  ];
  const help = [
    [tr('怎么填')],
    [tr('1. 在第一个工作表里每行填一笔账单，第一行表头不要改。')],
    [tr('2. 商家、到期日期、金额必填；商家没有固定账期时必须填到期日期。')],
    [tr('3. 日期写成 日/月/年，例如 05/11/2026；金额直接填数字，例如 1234,56。')],
    [tr('4. 单号列已设为文本格式，前导零会保留。')],
    [tr('5. 日常缴费在「分类」填类型（见下表）；商家货款留空。')],
    [tr('6. 付款账号要和 App 里的名称一致；留空用默认账号。')],
    [tr('7. 同商家、同单号（或同到期日和金额）的账单会自动跳过，不会重复导入。')],
    [tr('8. 已经付过的账单在「付款日期」填付款那天（或填「已付」，按到期日算）；没付留空。')],
    [''],
    [tr('分类可填')],
    ...EXPENSE_CATEGORIES.map((c) => [c.label, c.pt]),
  ];
  return writeXlsx([
    { name: tr('账单'), rows, header: true, widths: [24, 14, 14, 14, 14, 20, 14, 14, 30], textCols: [1] },
    { name: tr('说明'), rows: help, widths: [72, 28] },
  ]);
}

/** 文字文件：先按 UTF-8 读，出现乱码再按 Windows-1252（巴西版 Excel 存的 CSV） */
function decodeText(buf: Uint8Array): string {
  const utf = new TextDecoder('utf-8').decode(buf);
  if (!utf.includes('\uFFFD')) return utf;
  try {
    return new TextDecoder('windows-1252').decode(buf);
  } catch {
    return utf;
  }
}

/** 从 Excel / CSV 批量导入账单 */
export function ImportTable() {
  const store = useStore();
  const { bills, merchants, accounts, settings, today, repo, guard, reload, go } = store;
  const fb = useFeedback();
  const [text, setText] = useState('');
  const [sheet, setSheet] = useState<{ file: string; rows: string[][] } | null>(null);
  const [fields, setFields] = useState<Field[] | null>(null);
  const [createMissing, setCreateMissing] = useState(true);
  const [busy, setBusy] = useState(false);

  const plan: ImportPlan | null = useMemo(() => {
    const input = sheet ? sheet.rows : text;
    if (typeof input === 'string' ? !input.trim() : !input.length) return null;
    return planImport(input, { merchants, accounts, bills, settings, today, uuid, now: nowISO() }, fields ?? undefined);
  }, [text, sheet, merchants, accounts, bills, settings, today, fields]);

  const clear = () => {
    setText('');
    setSheet(null);
    setFields(null);
  };

  const openFile = async (f: File) => {
    setFields(null);
    const buf = new Uint8Array(await f.arrayBuffer());
    if (buf[0] === 0xd0 && buf[1] === 0xcf) return fb.toast(tr('这是旧版 .xls 文件，请在 Excel 里「另存为」.xlsx 或 CSV 后再选'), { bad: true });
    if (looksLikeZip(buf)) {
      try {
        const r = readXlsx(buf);
        if (!r.rows.length) return fb.toast(tr('表格是空的'), { bad: true });
        setText('');
        setSheet({ file: f.name, rows: r.rows });
      } catch (e) {
        fb.toast(e instanceof XlsxError ? tx(e.message) : tr('读取表格失败，请另存为 .xlsx 或 CSV 再试'), { bad: true });
      }
      return;
    }
    setSheet(null);
    setText(decodeText(buf));
  };

  const run = async () => {
    if (!plan) return;
    const rows = plan.rows.filter((r) => r.bill && !r.duplicateOf);
    if (!rows.length) return fb.toast(tr('没有可导入的行'), { bad: true });
    setBusy(true);
    try {
      const newM: Merchant[] = [];
      if (createMissing) {
        for (const name of plan.newMerchants) {
          const isPayee = rows.some((r) => r.bill!.kind === 'expense' && r.bill!.merchantNameSnapshot.toLowerCase() === name.toLowerCase());
          const m: Merchant = { id: uuid(), name, aliases: [], defaultAccountId: null, active: true, color: (merchants.length + newM.length) % 7, createdAt: nowISO(), updatedAt: nowISO(), ...(isPayee ? { type: 'payee' as const } : {}) };
          newM.push(m);
        }
      }
      const byName = new Map(newM.map((m) => [m.name.toLowerCase(), m]));
      const list = rows.map((r) => {
        const b = r.bill!;
        const m = b.merchantId ? null : byName.get(b.merchantNameSnapshot.toLowerCase());
        return m ? { ...b, merchantId: m.id } : b;
      });
      const ok = await guard(async () => {
        await repo.upsertMany({ bills: list, merchants: newM });
        return true;
      });
      if (!ok) return;
      await reload();
      fb.toast(tr('已导入 {0} 笔账单{1}', list.length, newM.length ? tr('，新建 {0} 个商家', newM.length) : ''), { action: { label: tr('查看账单'), run: () => go({ name: 'bills' }) } });
      clear();
    } finally {
      setBusy(false);
    }
  };

  const defAcc = accounts.find((a) => a.id === settings.defaultAccountId && a.active)?.label ?? '';

  return (
    <section className="card stack" aria-labelledby="h-imp">
      <h2 id="h-imp">{tr('Excel 批量导入账单')}</h2>
      <ol className="small muted steps" style={{ margin: 0 }}>
        <li>{tr('下载 Excel 模板，每行填一笔账单（商家、到期日期、金额必填）')}</li>
        <li>{tr('保存后在这里选择文件，核对预览再导入')}</li>
      </ol>
      <div className="grid2">
        <button
          className="btn"
          onClick={async () => {
            const r = await saveFile(tr('账单导入模板.xlsx'), buildTemplate(today, defAcc), XLSX_MIME);
            if (r.outcome === 'saved') fb.toast(tr('模板已下载，填好后再导入'));
            else if (r.outcome === 'unsupported') fb.toast(r.message ?? tr('当前环境不允许直接下载此类文件'), { bad: true });
          }}
        >
          <IDownload />
          {tr('下载 Excel 模板')}
        </button>
        <label className="btn btn-primary">
          <IUpload />
          {tr('选择 Excel / CSV 文件')}
          <input
            type="file"
            accept=".xlsx,.csv,.txt,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv,text/plain"
            className="sr-only"
            onChange={async (e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (f) await openFile(f);
            }}
          />
        </label>
      </div>
      {sheet && (
        <div className="codebox">
          <IFile width={16} height={16} />
          <span className="grow small" style={{ overflowWrap: 'anywhere' }}>
            {sheet.file} · {tr('{0} 行', sheet.rows.length)}
          </span>
          <button className="btn btn-sm btn-ghost" onClick={clear}>
            {tr('清空')}
          </button>
        </div>
      )}
      {!sheet && (
        <details className="more">
          <summary className="small">{tr('也可以从表格复制粘贴，或用 CSV 模板')}</summary>
          <div className="stack" style={{ paddingTop: 8 }}>
            <p className="xs muted" style={{ margin: 0 }}>
              {tr('从 Excel、Google 表格里复制整块内容（含表头）粘贴进来，或选择 .csv 文件。支持中文和葡文表头：商家/Fornecedor、单号/NF、开单/Emissão、到期/Vencimento、金额/Valor、付款账号、分类、备注。')}
            </p>
            <div className="field">
              <label htmlFor="imp-text">{tr('或直接粘贴')}</label>
              <textarea
                id="imp-text"
                className="input"
                rows={4}
                value={text}
                onChange={(e) => {
                  setText(e.target.value);
                  setFields(null);
                }}
                placeholder={tr('商家;单号;开单日期;到期日期;金额\nLoja Exemplo;0042;01/09/2026;01/10/2026;1.234,56')}
                spellCheck={false}
              />
            </div>
            <button
              className="btn btn-sm btn-ghost"
              style={{ alignSelf: 'flex-start' }}
              onClick={async () => {
                const r = await saveFile(tr('账单导入模板.csv'), tx(IMPORT_TEMPLATE), 'text/csv;charset=utf-8');
                if (r.outcome === 'saved') fb.toast(tr('模板已下载，填好后再导入'));
              }}
            >
              <IDownload />
              {tr('下载 CSV 模板')}
            </button>
          </div>
        </details>
      )}

      {plan && plan.rows.length > 0 && (
        <>
          <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
            <span className="pill paid">
              <ICheck width={13} height={13} /> {tr('可导入')} {plan.okCount}
            </span>
            {plan.dupCount > 0 && <span className="pill dueSoon">{tr('重复跳过')} {plan.dupCount}</span>}
            {plan.badCount > 0 && <span className="pill overdue">{tr('有问题')} {plan.badCount}</span>}
          </div>
          <details className="more" open={plan.fields.some((f, i) => f === 'skip' && plan.headers[i]) || !plan.fields.includes('amount') || undefined}>
            <summary className="small">{tr('列对应（已自动识别，可修改）')}</summary>
            <div className="impcols">
              {plan.fields.map((f, i) => (
                <label key={i} className="impcol">
                  <span className="xs muted">{tr('第 {0} 列', i + 1)}{plan.headers[i] && plan.headers[i] !== f ? tr('（{0}）', plan.headers[i]) : ''}</span>
                  <select
                    className="input"
                    value={f}
                    aria-label={tr('第 {0} 列对应字段', i + 1)}
                    onChange={(e) => {
                      const next = [...plan.fields];
                      next[i] = e.target.value as Field;
                      setFields(next);
                    }}
                  >
                    {(Object.keys(FIELD_LABEL) as Field[]).map((k) => (
                      <option key={k} value={k}>
                        {tx(FIELD_LABEL[k])}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
            </div>
          </details>
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>{tr('行')}</th>
                  <th>{tr('商家')}</th>
                  <th>{tr('到期')}</th>
                  <th className="r">{tr('金额')}</th>
                  <th>{tr('状态')}</th>
                </tr>
              </thead>
              <tbody>
                {plan.rows.slice(0, 30).map((r) => (
                  <tr key={r.index}>
                    <td className="num">{r.index}</td>
                    <td>
                      {r.bill?.merchantNameSnapshot || r.merchantName || '—'}
                      {r.bill && !r.merchantId && <span className="tag" style={{ marginLeft: 4 }}>{tr('新商家')}</span>}
                    </td>
                    <td className="num">{r.bill ? formatBR(r.bill.dueDate) : '—'}</td>
                    <td className="r num">{r.bill ? formatBRL(r.bill.totalCents) : '—'}</td>
                    <td className={r.issues.length ? 'err' : r.duplicateOf ? '' : 'ok'}>
                      {r.issues.length ? (
                        <>
                          <IX width={13} height={13} /> {r.issues.map(tx).join(tr('；'))}
                        </>
                      ) : r.duplicateOf ? (
                        tr('已存在（{0}），跳过', r.duplicateOf.orderNumber ? tr('单号 {0}', r.duplicateOf.orderNumber) : formatBR(r.duplicateOf.dueDate))
                      ) : (
                        <>
                          <ICheck width={13} height={13} /> {r.bill?.paidAt ? tr('可导入 · 已付 {0}', formatBR(r.bill.paidAt.slice(0, 10)).slice(0, 5)) : tr('可导入')}
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {plan.rows.length > 30 && <p className="xs muted" style={{ margin: 0 }}>{tr('只显示前 30 行，导入时会处理全部')} {plan.rows.length} {tr('行。')}</p>}
          {plan.newMerchants.length > 0 && (
            <label className="check" style={{ padding: 0 }}>
              <input type="checkbox" checked={createMissing} onChange={(e) => setCreateMissing(e.target.checked)} />
              <span>
                {tr('自动新建')} {plan.newMerchants.length} {tr('个商家：')}{plan.newMerchants.slice(0, 3).join(tr('、'))}
                {plan.newMerchants.length > 3 ? '…' : ''}
              </span>
            </label>
          )}
          <div className="row">
            <button className="btn btn-primary" disabled={busy || !plan.okCount} onClick={run}>
              {busy ? <span className="spin" /> : <ICheck />}
              {tr('导入')} {plan.okCount} {tr('笔账单')}
            </button>
            <button className="btn btn-ghost" onClick={clear}>
              {tr('清空')}
            </button>
          </div>
        </>
      )}
    </section>
  );
}

/** 独立页面：从首页、账单页、新增菜单进入 */
export function ImportPage() {
  return (
    <div className="stack">
      <ImportTable />
    </div>
  );
}
