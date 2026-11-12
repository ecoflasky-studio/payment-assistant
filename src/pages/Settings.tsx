import { tr, tx, lang, savedLang, setLang, LANGS, type Lang } from '../i18n';
import { useTheme, type ThemePref } from '../theme';
import { ISun, IStore, IGlobe } from '../ui/icons';
import { centsToInput, parseBRL } from '../lib/money';
import { useEffect, useState, type ReactNode } from 'react';
import { useStore } from '../store';
import { useFeedback } from '../ui/feedback';
import { useActions } from '../actions';
import { notifyState, requestNotify, showNotification, type NotifyState } from '../lib/platform';
import { listProviders, normalizeFn, supaFnUrl, type ProviderInfo } from '../lib/ocr/providers';
import { copyLazy } from '../lib/platform';
import { APP_VERSION, BUILD_ID } from '../lib/errorReport';
import { isNative, platform, openExternal } from '../native/platform';
import { legalUrl } from './Billing';
import { IBell, ICal, IDatabase, IHelp, IShield, ICloud, IFile, IInfo, ITool, IKey } from '../ui/icons';
import { PLAN_LABEL } from '../cloud/api';
import type { useReminders } from '../reminders';
import { SyncSettings, syncLabel } from './SyncSettings';

const NS_LABEL: Record<NotifyState, [string, string]> = {
  granted: [tr('已允许'), 'paid'],
  denied: [tr('已拒绝'), 'overdue'],
  default: [tr('尚未询问'), 'dueSoon'],
  unsupported: [tr('此环境不支持'), 'neutral'],
};

/** 设置首页：按组排的列表，细项在子页面里 */
export function SettingsPage() {
  const { go, auth, gate, ent, sync, syncNow, publicConfig } = useStore();
  const fb = useFeedback();
  // 账号版：普通用户只看到账号自动同步；手动云同步、识别服务部署只给管理员或自建版
  const showAdmin = !gate.saas || ent?.plan === 'owner';
  const acc = auth.account;
  const site = publicConfig?.site;
  const desktop = typeof matchMedia !== 'undefined' && matchMedia('(pointer: fine)').matches;
  const usage = acc?.usage;
  const unlimited = !usage || usage.limit == null || usage.limit > 9999;
  const aiLeft = usage && !unlimited ? Math.max(0, usage.limit - usage.ai) + (usage.bonus ?? 0) : null;
  return (
    <>
      <button className="card setacc linkcard" onClick={() => go({ name: 'account' })}>
        <span className="setacc-av" aria-hidden="true">
          {auth.session ? (auth.session.user.email[0] || '?').toUpperCase() : <ICloud width={22} height={22} />}
        </span>
        <span className="grow stack" style={{ gap: 2, minWidth: 0 }}>
          <b className="ellipsis">{auth.session ? auth.session.user.email : tr('登录账号')}</b>
          <span className="small muted">
            {auth.session ? (
              <>
                {acc && <span className={`pill ${acc.plan === 'expired' ? 'overdue' : acc.plan === 'trial' ? 'dueSoon' : 'paid'}`}>{PLAN_LABEL[acc.plan]}</span>} {aiLeft !== null ? tr('AI 识别剩 {0} 次', aiLeft) : acc ? tr('账号与套餐') : tr('已登录')}
              </>
            ) : (
              tr('登录后账单自动同步到你的所有设备')
            )}
          </span>
        </span>
        <span className="chev" aria-hidden="true">›</span>
      </button>

      <SetGroup title={tr('账单')}>
        <SetRow icon={<IStore />} title={tr('固定资料')} sub={tr('商家、缴费单位、付款账号')} onClick={() => go({ name: 'masters' })} />
        <SetRow icon={<IBell />} title={tr('提醒与预算')} sub={tr('到期通知、提前几天提醒、每月预算、导出日历')} onClick={() => go({ name: 'set-remind' })} />
        <SetRow icon={<IShield />} title={tr('AI 识别与隐私')} sub={tr('识别方式、上传前询问、错误报告')} onClick={() => go({ name: 'set-ai' })} />
      </SetGroup>

      <SetGroup title={tr('偏好')}>
        <ThemeRow />
        <LanguageRow />
      </SetGroup>

      <SetGroup title={tr('数据')}>
        {auth.session ? (
          <SetRow
            icon={<ICloud />}
            title={tr('多设备同步')}
            sub={sync.config?.account ? syncLabel(sync) : tr('已登录，账单随账号自动保存')}
            end={
              sync.config?.account ? (
                <button
                  className="btn btn-sm btn-soft"
                  disabled={sync.status === 'syncing'}
                  onClick={async (e) => {
                    e.stopPropagation();
                    const r = await syncNow();
                    if (r) fb.toast(tr('同步完成：下载 {0} 条，上传 {1} 条', r.applied, r.pushed));
                  }}
                >
                  {sync.status === 'syncing' ? <span className="spin" /> : null}
                  {tr('立即同步')}
                </button>
              ) : undefined
            }
          />
        ) : gate.saas ? (
          <SetRow icon={<ICloud />} title={tr('多设备同步')} sub={tr('登录后自动开启，不用任何设置')} onClick={() => go({ name: 'account' })} />
        ) : null}
        <SetRow icon={<IDatabase />} title={tr('数据管理')} sub={tr('备份、恢复、存储空间、清空数据')} onClick={() => go({ name: 'data' })} />
      </SetGroup>

      <SetGroup title={tr('帮助与关于')}>
        <SetRow icon={<IHelp />} title={tr('使用教程')} sub={tr('三步上手、拍照技巧、安装到主屏幕、常见问题')} onClick={() => go({ name: 'help' })} />
        {desktop && <ShortcutsRow />}
        <SetRow icon={<IFile />} title={tr('隐私政策')} onClick={() => void openExternal(legalUrl('privacy', site))} external />
        <SetRow icon={<IFile />} title={tr('使用条款')} onClick={() => void openExternal(legalUrl('terms', site))} external />
        <SetRow icon={<IInfo />} title={tr('版本')} end={<span className="small muted num">v{APP_VERSION} ({BUILD_ID}){isNative() ? ` · ${platform() === 'ios' ? 'iOS' : 'Android'}` : ''}</span>} />
      </SetGroup>

      {showAdmin && (
        <SetGroup title={tr('管理员')}>
          <SetRow icon={<ITool />} title={tr('部署与识别服务')} sub={gate.saas ? tr('只有管理员看得到：识别函数、自建服务、手动云同步') : tr('手动云同步、开启 AI 识别（Supabase + Gemini）')} onClick={() => go({ name: 'set-dev' })} />
        </SetGroup>
      )}
    </>
  );
}

function SetGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="setgroup" aria-label={title}>
      <h2 className="set-h">{title}</h2>
      <div className="card setlist">{children}</div>
    </section>
  );
}

function SetRow({ icon, title, sub, end, onClick, external }: { icon: ReactNode; title: string; sub?: ReactNode; end?: ReactNode; onClick?: () => void; external?: boolean }) {
  const body = (
    <>
      <span className="set-ic" aria-hidden="true">
        {icon}
      </span>
      <span className="grow stack" style={{ gap: 1, minWidth: 0 }}>
        <span className="set-t">{title}</span>
        {sub && <span className="xs muted set-sub">{sub}</span>}
      </span>
      {end}
      {onClick && !end && <span className="chev" aria-hidden="true">{external ? '↗' : '›'}</span>}
    </>
  );
  return onClick && !end ? (
    <button type="button" className="setrow clickable" onClick={onClick}>
      {body}
    </button>
  ) : (
    <div className="setrow">{body}</div>
  );
}

function ShortcutsRow() {
  return (
    <details className="setrow-details">
      <summary className="setrow clickable">
        <span className="set-ic" aria-hidden="true">
          <IKey />
        </span>
        <span className="grow set-t">{tr('电脑快捷键')}</span>
        <span className="chev" aria-hidden="true">›</span>
      </summary>
      <ul className="steps small" style={{ margin: '0 16px 12px 52px' }}>
        <li><b>N</b> {tr('新增账单')}</li>
        <li><b>/</b> {tr('搜索账单')}</li>
        <li><b>G</b> {tr('首页 ·')} <b>L</b> {tr('账单 ·')} <b>F</b> {tr('流水')}</li>
        <li><b>Esc</b> {tr('关闭弹窗')}</li>
      </ul>
    </details>
  );
}

/** 子页面：提醒与预算 */
export function RemindSettingsPage({ rem }: { rem: ReturnType<typeof useReminders> }) {
  const { settings, saveSettings, bills, today } = useStore();
  const { exportICS } = useActions();
  const fb = useFeedback();
  const [ns, setNs] = useState<NotifyState>(notifyState());
  const unpaid = bills.filter((b) => !b.paidAt);
  const test = async () => {
    const ok = await showNotification(tr('账期助手 · 测试通知'), tr('通知工作正常。到期提醒会在应用打开时这样出现。'), 'test');
    fb.toast(ok ? tr('已发送测试通知') : tr('发送失败：浏览器没有显示通知'), { bad: !ok });
  };
  const [label, tone] = NS_LABEL[ns];
  return (
    <>
      <section className="card stack" aria-labelledby="h-rem">
        <h2 id="h-rem" className="row">
          <IBell width={20} height={20} /> {tr('提醒与日历')}
        </h2>
        <div className="row between">
          <span className="small">
            {tr('系统通知')} <span className={`pill ${tone}`}>{label}</span>
          </span>
          <div className="row" style={{ gap: 6 }}>
            {ns === 'default' && (
              <button className="btn btn-sm btn-primary" onClick={async () => setNs(await requestNotify())}>
                {tr('允许通知')}
              </button>
            )}
            {ns === 'granted' && (
              <button className="btn btn-sm" onClick={test}>
                {tr('测试')}
              </button>
            )}
            <button className="btn btn-sm btn-ghost" onClick={rem.recheck}>
              {tr('立即检查')}
            </button>
          </div>
        </div>
        {ns === 'denied' && <p className="small err">{tr('通知被拒绝，请在浏览器的网站设置里改为「允许」。')}</p>}
        <label className="check">
          <input type="checkbox" checked={settings.notificationsEnabled} onChange={(e) => saveSettings({ notificationsEnabled: e.target.checked })} />
          <span>{tr('打开应用时发送到期通知（每笔每天最多一次）')}</span>
        </label>
        <div className="grid2">
          <div className="field">
            <label htmlFor="s-rd">{tr('默认提前提醒（天）')}</label>
            <input id="s-rd" className="input num" inputMode="numeric" value={settings.defaultReminderDays} onChange={(e) => { const n = Number(e.target.value.replace(/\D/g, '') || 0); saveSettings({ defaultReminderDays: Math.min(60, n) }); }} />
          </div>
          <div className="field">
            <label htmlFor="s-ds">{tr('「即将到期」范围（天）')}</label>
            <input id="s-ds" className="input num" inputMode="numeric" value={settings.dueSoonDays} onChange={(e) => { const n = Number(e.target.value.replace(/\D/g, '') || 0); saveSettings({ dueSoonDays: Math.min(60, Math.max(1, n)) }); }} />
          </div>
        </div>
        <div className="field" style={{ maxWidth: 260 }}>
          <label htmlFor="s-budget">{tr('每月支出预算 R$（可空）')}</label>
          <input
            id="s-budget"
            className="input num"
            inputMode="decimal"
            defaultValue={settings.monthlyBudgetCents ? centsToInput(settings.monthlyBudgetCents) : ''}
            placeholder={tr('如 20.000,00')}
            onBlur={(e) => {
              const v = e.target.value.trim();
              if (!v) return saveSettings({ monthlyBudgetCents: null });
              const c = parseBRL(v).cents;
              if (c) {
                saveSettings({ monthlyBudgetCents: c });
                e.target.value = centsToInput(c);
              }
            }}
          />
          <span className="hint">{tr('在「流水」页显示本月实付进度，超出会提醒。')}</span>
        </div>
        <div className="divider" />
        <div className="row between">
          <span className="small">
            <ICal width={16} height={16} style={{ verticalAlign: -3 }} /> {tr('关屏也要提醒：导出到手机日历（含提前闹钟）')}
          </span>
          <button className="btn btn-primary" disabled={!unpaid.length} onClick={() => exportICS(unpaid, tr('账期-全部未付-{0}.ics', today))}>
            {tr('导出全部未付账单')}
          </button>
        </div>
      </section>

    </>
  );
}

/** 子页面：AI 识别与隐私（普通用户只看状态和开关；部署相关在管理员页面） */
export function AiSettingsPage() {
  const { settings, saveSettings, cloud, getToken, auth, gate, ent } = useStore();
  const showAdmin = !gate.saas || ent?.plan === 'owner';
  const [providers, setProviders] = useState<ProviderInfo[] | null>(null);
  useEffect(() => {
    setProviders(null);
    (async () => listProviders(settings.recognizeEndpoint, settings.recognizeToken, cloud ? { ...cloud, bearer: await getToken() } : null))().then(setProviders);
  }, [settings.recognizeEndpoint, settings.recognizeToken, cloud?.url, cloud?.key, cloud?.fn, auth.session?.user.id]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <>
      <section className="card stack" aria-labelledby="h-ocr">
        <h2 id="h-ocr" className="row">
          <IShield width={20} height={20} /> {tr('识别方式')}
        </h2>
        {!providers ? (
          <span className="row small muted">
            <span className="spin" /> {tr('检查中…')}
          </span>
        ) : (
          <div className="list">
            {providers.filter((p) => (showAdmin ? p.id === 'supabase' || p.id === 'local' || p.available : p.id === 'supabase' || p.id === 'local')).map((p) => (
              <div key={p.id} className="li">
                <div className="grow stack" style={{ gap: 2 }}>
                  <span className="t">{p.label}</span>
                  {showAdmin && <span className="xs muted">{p.cost}</span>}
                  {p.reason && <span className="xs err">{tx(p.reason)}</span>}
                </div>
                <span className={`pill ${p.available ? 'paid' : 'neutral'}`}>{p.available ? tr('可用') : tr('未开启')}</span>
              </div>
            ))}
          </div>
        )}
      </section>
      <section className="card stack" aria-labelledby="h-priv">
        <h2 id="h-priv" className="row">
          {tr('隐私')}
        </h2>
        <label className="check">
          <input type="checkbox" checked={settings.cloudConsent} onChange={(e) => saveSettings({ cloudConsent: e.target.checked })} />
          <span>{tr('发送图片识别前不再逐次询问（取消勾选即可恢复每次询问）')}</span>
        </label>
        <label className="check">
          <input type="checkbox" checked={!!settings.cropFirst} onChange={(e) => saveSettings({ cropFirst: e.target.checked })} />
          <span>
            {tr('识别前先框选范围')}
            <br />
            <span className="xs muted">{tr('默认关闭：拍完直接识别整张图（相机取景框内）；需要时可在识别页点「调整范围」。')}</span>
          </span>
        </label>
        <label className="check">
          <input type="checkbox" checked={settings.errorReports !== false} onChange={(e) => saveSettings({ errorReports: e.target.checked })} />
          <span>
            {tr('出错时发送匿名错误报告')}
            <br />
            <span className="xs muted">{tr('只包含出错位置和版本号，金额、单号、商家等账单内容会先被抹掉，帮助我们更快修复问题。')}</span>
          </span>
        </label>
        <p className="xs muted">{tr('默认不上传任何票据。只有你同意后，才会发送当前这 1 张图片。')}</p>
      </section>
    </>
  );
}

/** 子页面：部署与识别服务（管理员 / 自建版） */
export function DevSettingsPage() {
  const { settings, saveSettings, cloud, getToken, gate, ent } = useStore();
  const showAdmin = !gate.saas || ent?.plan === 'owner';
  const supa = cloud;
  const withBearer = async (t: typeof supa) => (t ? { ...t, bearer: await getToken() } : null);
  const fb = useFeedback();
  const [providers, setProviders] = useState<ProviderInfo[] | null>(null);
  const [endpoint, setEndpoint] = useState(settings.recognizeEndpoint);
  const [token, setToken] = useState(settings.recognizeToken);
  const [testing, setTesting] = useState(false);
  const [showToken, setShowToken] = useState(false);
  useEffect(() => {
    withBearer(supa).then((t) => listProviders(settings.recognizeEndpoint, settings.recognizeToken, t)).then(setProviders);
  }, [settings.recognizeEndpoint, settings.recognizeToken, supa?.url, supa?.key, supa?.fn]); // eslint-disable-line react-hooks/exhaustive-deps
  const aiReady = !!providers?.some((p) => p.available && p.id !== 'local');
  const [fnText, setFnText] = useState(settings.recognizeFn ?? '');
  useEffect(() => setFnText(settings.recognizeFn ?? ''), [settings.recognizeFn]);
  const recheck = async () => {
    setTesting(true);
    const fn = normalizeFn(fnText, supa?.url);
    if (fn !== (settings.recognizeFn ?? '')) await saveSettings({ recognizeFn: fn || null });
    setFnText(fn);
    const ps = await listProviders(settings.recognizeEndpoint, settings.recognizeToken, await withBearer(supa ? { ...supa, fn } : null));
    setProviders(ps);
    setTesting(false);
    const sb = ps.find((p) => p.id === 'supabase')!;
    fb.toast(sb.available ? tr('{0} 已开启', sb.label) : tr('AI 识别未开启：{0}', sb.reason ?? tr('未知原因')), { bad: !sb.available });
  };
  const normalizeEndpoint = (v: string) => {
    let e = v.trim();
    if (!e) return '/api/recognize';
    if (/^[\w.-]+\.[a-z]{2,}(\/|$)/i.test(e)) e = `https://${e}`;
    if (/^https?:\/\/[^/]+\/?$/i.test(e)) e = e.replace(/\/?$/, '/api/recognize');
    return e;
  };
  const saveAndTest = async () => {
    const ep = normalizeEndpoint(endpoint);
    setEndpoint(ep);
    setTesting(true);
    await saveSettings({ recognizeEndpoint: ep, recognizeToken: token.trim() });
    const ps = await listProviders(ep, token.trim(), await withBearer(supa));
    setProviders(ps);
    setTesting(false);
    const srv = ps.find((p) => p.id === 'server')!;
    fb.toast(srv.available ? tr('连接成功，云端识别已开启') : tr('未连通：{0}', srv.reason ?? tr('未知原因')), { bad: !srv.available });
  };
  if (!showAdmin) return <section className="card"><p className="small muted">{tr('这里只有管理员能看到。')}</p></section>;
  return (
    <>
      {gate.saas && <div className="banner info small">{tr('普通用户看不到这一页：账号登录后由系统自动分配同步空间，不需要手动设置。')}</div>}
      <SyncSettings />
      <section className="card stack" aria-labelledby="h-dev-ai">
        <h2 id="h-dev-ai" className="row">
          <IShield width={20} height={20} /> {tr('识别服务')}
        </h2>
        {!providers ? (
          <span className="row small muted">
            <span className="spin" /> {tr('检查中…')}
          </span>
        ) : (
          <div className="list">
            {providers.filter((p) => p.id === 'supabase' || p.id === 'local' || p.available).map((p) => (
              <div key={p.id} className="li">
                <div className="grow stack" style={{ gap: 2 }}>
                  <span className="t">{p.label}</span>
                  <span className="xs muted">{p.cost}</span>
                  {p.reason && <span className="xs err">{tx(p.reason)}</span>}
                </div>
                <span className={`pill ${p.available ? 'paid' : 'neutral'}`}>{p.available ? tr('可用') : tr('未开启')}</span>
              </div>
            ))}
          </div>
        )}
        {supa && (
          <div className="field">
            <label htmlFor="s-fn">{tr('识别函数名')}</label>
            <div className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
              <input id="s-fn" className="input mono grow" value={fnText} onChange={(e) => setFnText(e.target.value)} placeholder="recognize" autoComplete="off" spellCheck={false} />
              <button className="btn" onClick={recheck} disabled={testing}>
                {testing ? <span className="spin" /> : null}
                {tr('保存并检查')}
              </button>
            </div>
            <span className="hint">
              {tr('Supabase 函数页面顶部网址')} <span className="mono">/functions/v1/</span> {tr('后面那一段；也可以直接粘贴整个网址。当前调用：')}<span className="mono">{supaFnUrl({ ...supa, fn: normalizeFn(fnText, supa.url) })}</span>
            </span>
          </div>
        )}
        {!supa && (
          <div className="row">
            <button className="btn btn-sm" onClick={recheck} disabled={testing}>
              {testing ? <span className="spin" /> : null}
              {tr('重新检查')}
            </button>
          </div>
        )}

        <details className="more guide" open={!!providers && !aiReady}>
          <summary>{tr('开启 AI 识别：Supabase + Gemini（约 5 分钟，只需做一次）')}</summary>
          {!supa && (
            <p className="small err">{tr('第 0 步：先在上面的「云同步」里连接 Supabase（识别函数部署在同一个项目里，App 会自动用同步配置调用它）。')}</p>
          )}
          <ol className="steps small">
            <li>
              {tr('打开')} <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener noreferrer">aistudio.google.com/apikey</a>{tr('，用 Google 账号登录，点')} <b>Create API key</b>{tr('，复制密钥。')}
            </li>
            <li>
              {tr('打开')} <a href="https://supabase.com/dashboard" target="_blank" rel="noopener noreferrer">{tr('Supabase 控制台')}</a> {tr('→ 你同步用的项目 → 左侧')} <b>Edge Functions</b> → <b>Secrets</b> {tr('→ 添加：名称')} <span className="mono">GEMINI_API_KEY</span>{tr('，值粘贴第 1 步的密钥 → 保存。')}
            </li>
            <li>
              <b>Edge Functions</b> → <b>Deploy a new function</b> → <b>Via Editor</b>{tr('；左上角的函数名（决定网址）改成')} <span className="mono">recognize</span>{tr('，删掉示例代码，粘贴下面复制的代码 →')} <b>Deploy function</b>{tr('。部署后若网址最后一段不是 recognize（例如 quick-api），把它填到上面的「识别函数名」即可。')}
              <div className="row" style={{ marginTop: 6 }}>
                <button
                  className="btn btn-sm btn-soft"
                  onClick={async () => {
                    const n = await copyLazy(() => import('../../supabase/functions/recognize/index.ts?raw').then((m) => m.default));
                    fb.toast(n ? tr('已复制识别函数代码（{0} KB）', Math.round(n / 1024)) : tr('复制失败，请从项目 supabase/functions/recognize 目录获取'), { bad: false });
                  }}
                >
                  {tr('复制识别函数代码')}
                </button>
              </div>
            </li>
            <li>
              {tr('打开这个函数的')} <b>Settings</b>{tr('，把')} <b>Verify JWT</b>{tr('（或 Enforce JWT Verification）')}<b>{tr('关掉')}</b> {tr('→ 保存。不关的话浏览器会报「连接不到识别函数」。函数自己会校验你的 publishable key，别人拿不到你的密钥。')}
            </li>
            <li>{tr('回到这里点「保存并检查」，显示「可用」就完成了。别的设备导入同步配置后自动可用。')}</li>
          </ol>
          <p className="xs muted">
            {tr('隐私提醒：Gemini 免费额度下提交的内容可能被 Google 用于改进产品并由人工审阅。工资单、银行单据含个人信息，建议在 AI Studio 为这个密钥开启结算（付费层不用于训练，识别一张单据约几分钱）。想用 Claude：Secret 名称改为')} <span className="mono">ANTHROPIC_API_KEY</span>{tr('。')}
          </p>
        </details>

        <details className="more guide">
          <summary>{tr('其他方式：自建服务 / Cloudflare Worker / Claude App')}</summary>
          <div className="grid2 stack-sm">
            <div className="field">
              <label htmlFor="s-ep">{tr('自建识别服务地址')}</label>
              <input id="s-ep" className="input mono" value={endpoint} onChange={(e) => setEndpoint(e.target.value)} placeholder="https://xxx.workers.dev" autoComplete="off" spellCheck={false} />
            </div>
            <div className="field">
              <label htmlFor="s-tk">{tr('访问口令')}</label>
              <div className="datefield">
                <input id="s-tk" className="input mono" type={showToken ? 'text' : 'password'} value={token} onChange={(e) => setToken(e.target.value)} placeholder={tr('部署时自己设定的口令')} autoComplete="off" />
                <button type="button" className="btn datebtn" aria-label={showToken ? tr('隐藏口令') : tr('显示口令')} onClick={() => setShowToken((v) => !v)}>
                  {showToken ? tr('藏') : tr('看')}
                </button>
              </div>
            </div>
          </div>
          <div className="row">
            <button className="btn btn-sm btn-primary" onClick={saveAndTest} disabled={testing}>
              {tr('保存并测试连接')}
            </button>
            <button
              className="btn btn-sm btn-soft"
              onClick={async () => {
                const n = await copyLazy(() => import('../../worker/dist/zhangqi-worker.js?raw').then((m) => m.default));
                fb.toast(n ? tr('已复制 Worker 代码（{0} KB）', Math.round(n / 1024)) : tr('复制失败，请从项目 worker/dist 目录获取'), { bad: false });
              }}
            >
              {tr('复制 Cloudflare Worker 代码')}
            </button>
          </div>
          <p className="xs muted">
            {tr('Cloudflare：Workers & Pages → Create → Hello World → Edit code 粘贴 → Deploy；在 Settings → Variables and Secrets 添加')} <span className="mono">GEMINI_API_KEY</span>{tr('（或 ANTHROPIC_API_KEY）、')}<span className="mono">ACCESS_TOKEN</span>{tr('（自定口令）、')}<span className="mono">ALLOWED_ORIGINS</span>{tr('＝')}<span className="mono">{typeof location !== 'undefined' ? location.origin : tr('https://你的用户名.github.io')}</span>{tr('，再把 Worker 网址和口令填到上面。')}
          </p>
          <p className="xs muted">{tr('Claude App：把本应用发布为 Claude 页面后在 Claude App 里打开，会用你自己的 Claude 账号识别，不需要密钥。')}</p>
        </details>
      </section>
    </>
  );
}

/** 外观：光明 / 深色 / 跟随系统 */
function ThemeRow() {
  const [pref, setPref] = useTheme();
  return (
    <SetRow
      icon={<ISun />}
      title={tr('外观')}
      end={
        <div className="seg seg-sm" role="group" aria-label={tr('外观模式')}>
          {(
            [
              ['light', tr('光明')],
              ['dark', tr('深色')],
              ['system', tr('自动')],
            ] as [ThemePref, string][]
          ).map(([k, l]) => (
            <button key={k} aria-pressed={pref === k} onClick={() => setPref(k)}>
              {l}
            </button>
          ))}
        </div>
      }
    />
  );
}

/** 语言：跟随系统 / 简体中文 / Português / English（切换后重新加载） */
function LanguageRow() {
  const cur = savedLang();
  return (
    <SetRow
      icon={<IGlobe />}
      title={tr('语言')}
      sub={{ zh: 'Idioma · Language', pt: 'Language · 语言', en: 'Idioma · 语言' }[lang()]}
      end={
        <select className="input set-select" value={cur} aria-label={tr('Language / Idioma / 语言')} onChange={(e) => setLang(e.target.value as Lang | 'auto')}>
          <option value="auto">{tr('跟随系统')}</option>
          {LANGS.map((l) => (
            <option key={l.id} value={l.id}>
              {l.label}
            </option>
          ))}
        </select>
      }
    />
  );
}
