import { tr, tx } from '../i18n';
import type { Settings } from '../lib/types';
import { ImportTable } from './ImportTable';
import { EvalSection } from './EvalSection';
import { useEffect, useState } from 'react';
import { useStore } from '../store';
import { useFeedback } from '../ui/feedback';
import { makeBackup, validateBackup, previewImport, applyMerge, type BackupCheck, type ImportPreview, type ConflictPolicy } from '../lib/backup';
import { saveFile, copyText } from '../lib/platform';
import { storageInfo, requestPersist } from '../db/repo';
import { formatBRL } from '../lib/money';
import { billsCSV } from '../lib/flow';
import { formatBR } from '../lib/dates';
import { IDownload, IUpload, ITrash } from '../ui/icons';

const mb = (n: number) => `${(n / 1048576).toFixed(1)} MB`;

export function DataPage() {
  const { repo, settings, reload, guard, today, storageError, sync, syncNow, saveSettings, gate, requireFeature, bills } = useStore();
  const fb = useFeedback();
  const [info, setInfo] = useState<Awaited<ReturnType<typeof storageInfo>>>(null);
  const [check, setCheck] = useState<BackupCheck | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [mode, setMode] = useState<'merge' | 'replace'>('merge');
  const [policy, setPolicy] = useState<ConflictPolicy>('keepLocal');
  const [fileName, setFileName] = useState('');
  const [lastBackup, setLastBackup] = useState<string | null>(() => {
    try {
      return localStorage.getItem('zq.lastBackup');
    } catch {
      return null;
    }
  });

  const refreshInfo = () => storageInfo().then(setInfo);
  useEffect(() => {
    refreshInfo();
  }, []);

  const doExport = async (suffix = '') => {
    const data = await guard(() => repo.exportAll());
    if (!data) return false;
    const json = JSON.stringify(makeBackup(data, settings), null, 2);
    const name = tr('账期助手备份-{0}{1}.json', today, suffix);
    const r = await saveFile(name, json, 'application/json');
    if (r.outcome === 'saved' || r.outcome === 'shared') {
      const t = new Date().toISOString();
      try {
        localStorage.setItem('zq.lastBackup', t);
      } catch {}
      setLastBackup(t);
      fb.toast(tr('备份已导出：{0} 笔账单', data.bills.filter((b) => !b.deletedAt).length));
      return true;
    }
    if (r.outcome === 'unsupported') {
      const ok = await copyText(json);
      fb.toast(ok ? tr('无法直接下载，备份 JSON 已复制到剪贴板') : tr('导出失败'), { bad: !ok });
      return ok;
    }
    return false;
  };

  const onFile = async (f: File) => {
    setFileName(f.name);
    setPreview(null);
    if (f.size > 50 * 1024 * 1024) {
      setCheck({ ok: false, errors: [tr('文件超过 50 MB，不像是账期助手备份')], warnings: [], data: null });
      return;
    }
    const text = await f.text();
    const c = validateBackup(text);
    setCheck(c);
    if (c.ok && c.data) {
      const local = await guard(() => repo.exportAll());
      if (local) setPreview(previewImport(local, c.data));
    }
  };

  const doImport = async () => {
    if (!check?.data || !preview) return;
    const incoming = check.data;
    const ok = await fb.confirm({
      title: mode === 'replace' ? tr('用备份覆盖全部数据？') : tr('合并导入备份？'),
      body:
        mode === 'replace' ? (
          <p>{tr('当前设备上的账单、商家和账号将被备份内容完全替换（票据图片保留）。建议先导出一份当前数据。')}</p>
        ) : (
          <p>
            {tr('新增')} {preview.bills.add.length} {tr('笔、更新')} {preview.bills.update.length} {tr('笔账单；')}{preview.bills.conflict.length} {tr('个冲突将')}{policy === 'keepLocal' ? tr('保留本机版本') : tr('使用备份版本')}{tr('。')}
          </p>
        ),
      confirmLabel: mode === 'replace' ? tr('覆盖导入') : tr('合并导入'),
      danger: mode === 'replace',
    });
    if (!ok) return;
    const done = await guard(async () => {
      if (mode === 'replace') {
        if (sync.config) {
          // 同步开启时用删除墓碑代替物理清空，其他设备也会删除备份里没有的记录
          const keep = new Set([...incoming.bills, ...incoming.merchants, ...incoming.accounts].map((r) => r.id));
          await repo.tombstone((_k, id) => !keep.has(id));
          await repo.upsertMany(incoming);
        } else await repo.replaceAll(incoming);
      }
      else
        await repo.upsertMany({
          bills: applyMerge(preview.bills, policy),
          merchants: applyMerge(preview.merchants, policy),
          accounts: applyMerge(preview.accounts, policy),
        });
      return true;
    });
    if (!done) return;
    // 恢复备份里的设置（提醒天数、预算、默认商家/账号、识别服务地址）；本机专属的不动
    const bs = check.settings as Partial<Settings> | undefined;
    let restored = false;
    if (bs && typeof bs === 'object') {
      const keys = ['defaultReminderDays', 'dueSoonDays', 'defaultMerchantId', 'defaultAccountId', 'monthlyBudgetCents', 'notificationsEnabled', 'recognizeEndpoint', 'recognizeFn'] as const;
      const patch: Partial<Settings> = {};
      for (const k of keys) if (k in bs && bs[k] !== undefined) (patch as any)[k] = bs[k];
      if (Object.keys(patch).length) {
        await saveSettings(patch);
        restored = true;
      }
    }
    await reload();
    setCheck(null);
    setPreview(null);
    fb.toast(restored ? tr('导入完成，设置也已恢复') : tr('导入完成'));
  };

  const clearAll = async () => {
    const ok = await fb.confirm({
      title: tr('清空全部数据？'),
      body: (
        <>
          <p>{tr('将删除本机所有账单、商家、付款账号、票据图片和识别草稿。此操作无法撤销。')}</p>
          <p>
            <b>{tr('点击确认后会先导出一份备份')}</b>{tr('，备份成功后才会清空。')}
          </p>
        </>
      ),
      confirmLabel: tr('先备份，再清空'),
      danger: true,
    });
    if (!ok) return;
    const backed = await doExport(tr('-清空前'));
    if (!backed) {
      const force = await fb.confirm({ title: tr('备份没有完成'), body: tr('仍要在没有备份的情况下清空吗？'), confirmLabel: tr('不备份，直接清空'), danger: true });
      if (!force) return;
    }
    const again = await fb.confirm({
      title: tr('最后确认'),
      body: sync.config ? (sync.config?.account ? tr('你已登录：清空会同步到云端和你的其他设备（所有设备上的账单都会被删除）。真的要清空吗？') : tr('已开启云同步：清空会同步到云端和其他设备（所有设备上的账单都会被删除）。真的要清空吗？')) : tr('真的要清空全部数据吗？'),
      confirmLabel: tr('清空'),
      danger: true,
    });
    if (!again) return;
    if (sync.config) {
      await guard(async () => {
        await repo.tombstone();
        await repo.clearDraft();
      });
      await syncNow();
    } else await guard(() => repo.clearAll());
    await reload();
    refreshInfo();
    fb.toast(tr('已清空全部数据'));
  };

  const pct = info && info.quota ? info.usage / info.quota : 0;

  return (
    <>
      {storageError && (
        <div className="banner bad" role="alert">
          <span className="grow">
            <b>{tx(storageError.message)}</b> — {tx(storageError.hint)}
          </span>
        </div>
      )}

      <section className="card stack">
        <h2>{tr('备份')}</h2>
        <p className="small">{tr('把全部账单、商家、账号和设置导出为一个 JSON 文件（不含票据图片）。换手机或清理浏览器前务必备份。')}</p>
        <p className="xs muted">{tr('上次备份：')}{lastBackup ? new Date(lastBackup).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : tr('从未在此设备备份')}</p>
        <button className="btn btn-primary" style={{ alignSelf: 'flex-start' }} onClick={() => doExport()}>
          <IDownload />
          {tr('导出备份 JSON')}
        </button>
      </section>

      <section className="card stack">
        <h2>{tr('恢复')}</h2>
        <label className="btn" style={{ alignSelf: 'flex-start' }}>
          <IUpload />
          {tr('选择备份文件')}
          <input type="file" accept="application/json,.json" className="sr-only" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) onFile(f); }} />
        </label>
        {check && (
          <div className="stack">
            <span className="small">
              {tr('文件：')}<b>{fileName}</b>
            </span>
            {check.errors.length > 0 && (
              <div className="banner bad" role="alert">
                <div className="grow stack" style={{ gap: 4 }}>
                  <b>{tr('发现')} {check.errors.length} {tr('个错误，不能导入：')}</b>
                  {check.errors.slice(0, 12).map((e, i) => (
                    <span key={i} className="small">
                      · {e}
                    </span>
                  ))}
                  {check.errors.length > 12 && <span className="small">{tr('…还有')} {check.errors.length - 12} {tr('个')}</span>}
                </div>
              </div>
            )}
            {check.warnings.length > 0 && (
              <div className="banner warn">
                <div className="grow stack" style={{ gap: 4 }}>
                  {check.warnings.map((w, i) => (
                    <span key={i} className="small">
                      · {tx(w)}
                    </span>
                  ))}
                </div>
              </div>
            )}
            {preview && check.data && (
              <>
                <div className="tbl-wrap">
                  <table className="tbl num">
                    <thead>
                      <tr>
                        <th></th>
                        <th className="r">{tr('新增')}</th>
                        <th className="r">{tr('更新')}</th>
                        <th className="r">{tr('冲突')}</th>
                        <th className="r">{tr('相同')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(
                        [
                          [tr('账单'), preview.bills],
                          [tr('商家'), preview.merchants],
                          [tr('付款账号'), preview.accounts],
                        ] as const
                      ).map(([n, p]) => (
                        <tr key={n}>
                          <td>{n}</td>
                          <td className="r">{p.add.length}</td>
                          <td className="r">{p.update.length}</td>
                          <td className="r" style={p.conflict.length ? { color: 'var(--soon)', fontWeight: 800 } : undefined}>
                            {p.conflict.length}
                          </td>
                          <td className="r">{p.same}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {preview.bills.conflict.length > 0 && (
                  <details className="more">
                    <summary>{tr('查看')} {preview.bills.conflict.length} {tr('个账单冲突（本机版本较新或同时修改）')}</summary>
                    <div className="stack small" style={{ paddingTop: 6 }}>
                      {preview.bills.conflict.slice(0, 20).map(({ local, incoming }) => (
                        <span key={local.id}>
                          {local.merchantNameSnapshot} #{local.orderNumber || '—'}{tr('：本机')} {formatBRL(local.totalCents)} {tr('/ 到期')} {formatBR(local.dueDate)}
                          {local.paidAt ? tr(' 已付') : ''} {tr('⇄ 备份')} {formatBRL(incoming.totalCents)} / {formatBR(incoming.dueDate)}
                          {incoming.paidAt ? tr(' 已付') : ''}
                        </span>
                      ))}
                    </div>
                  </details>
                )}
                <div className="seg" role="group" aria-label={tr('导入方式')} style={{ alignSelf: 'flex-start' }}>
                  <button aria-pressed={mode === 'merge'} onClick={() => setMode('merge')}>
                    {tr('合并')}
                  </button>
                  <button aria-pressed={mode === 'replace'} onClick={() => setMode('replace')}>
                    {tr('覆盖')}
                  </button>
                </div>
                {mode === 'merge' && preview.bills.conflict.length + preview.merchants.conflict.length + preview.accounts.conflict.length > 0 && (
                  <div className="field">
                    <label htmlFor="pol">{tr('冲突时')}</label>
                    <select id="pol" className="input" value={policy} onChange={(e) => setPolicy(e.target.value as ConflictPolicy)}>
                      <option value="keepLocal">{tr('保留本机版本')}</option>
                      <option value="useIncoming">{tr('使用备份版本')}</option>
                    </select>
                  </div>
                )}
                <div className="row end">
                  <button className="btn btn-ghost" onClick={() => { setCheck(null); setPreview(null); }}>
                    {tr('取消')}
                  </button>
                  <button className={`btn ${mode === 'replace' ? 'btn-danger' : 'btn-primary'}`} onClick={doImport}>
                    {mode === 'replace' ? tr('确认覆盖导入') : tr('确认合并导入')}
                  </button>
                </div>
              </>
            )}
          </div>
        )}
      </section>

      <section className="card stack" aria-labelledby="h-export">
        <h2 id="h-export" className="row">
          <IDownload width={20} height={20} /> {tr('导出记录')} {!gate.canExport && <span className="pill neutral">T2</span>}
        </h2>
        <p className="small">{tr('把全部账单导出为表格（CSV，Excel / Planilhas Google 可直接打开），方便记账、报税和对账。每月流水也可以在「流水」页导出。')}</p>
        <button
          className="btn btn-primary"
          style={{ alignSelf: 'flex-start' }}
          onClick={async () => {
            if (!requireFeature('export')) return;
            const r = await saveFile(tr('账单记录-{0}.csv', today), billsCSV(bills, today), 'text/csv;charset=utf-8');
            if (r.outcome === 'saved' || r.outcome === 'shared') fb.toast(tr('已导出账单记录'));
          }}
        >
          <IDownload />
          {tr('导出账单记录（CSV）')}
        </button>
      </section>
      <ImportTable />
      <EvalSection />

      <section className="card stack">
        <h2>{tr('存储空间')}</h2>
        {info ? (
          <>
            <div className="progress" role="progressbar" aria-label={tr('已用空间')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct * 100)}>
              <div style={{ width: `${Math.max(2, pct * 100)}%`, animation: 'none', background: pct > 0.8 ? 'var(--overdue)' : 'var(--brand)' }} />
            </div>
            <span className="small">
              {tr('已用')} {mb(info.usage)} {tr('/ 可用约')} {mb(info.quota)} · {info.persisted ? tr('已设为持久存储') : tr('浏览器空间紧张时可能被清理')}
            </span>
            {!info.persisted && (
              <button className="btn btn-sm" style={{ alignSelf: 'flex-start' }} onClick={async () => { const ok = await requestPersist(); fb.toast(ok ? tr('已申请持久存储') : tr('浏览器未批准持久存储，请定期备份'), { bad: !ok }); refreshInfo(); }}>
                {tr('申请持久存储')}
              </button>
            )}
            {pct > 0.8 && <p className="err small">{tr('空间快满了：请导出备份后删除旧的已付账单（会一并删除其票据图片）。')}</p>}
          </>
        ) : (
          <p className="small muted">{tr('此浏览器不提供存储用量信息。')}</p>
        )}
        <p className="xs muted">{sync.config?.account ? tr('账单已随账号自动保存到云端；这里的备份是额外的一份，换账号或长期存档时用。') : tr('还没登录：数据只保存在这台设备上。登录后会自动同步到你的所有设备。')}</p>
      </section>

      <section className="card stack">
        <h2>{tr('危险操作')}</h2>
        <button className="btn btn-danger-text" style={{ alignSelf: 'flex-start' }} onClick={clearAll}>
          <ITrash />
          {tr('清空全部数据')}
        </button>
      </section>
    </>
  );
}
