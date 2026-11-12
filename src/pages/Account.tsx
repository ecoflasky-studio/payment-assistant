import { tr, tx } from '../i18n';
import { useEffect, useState } from 'react';
import { useStore, type Feature } from '../store';
import { useFeedback, Modal } from '../ui/feedback';
import { sendCode, verifyCode, isEmail, AuthError, signInPassword, signUpPassword, setPassword } from '../cloud/auth';
import { cancelSubscription, pushKey, pushSubscribe, pushUnsubscribe, pushTest, PLAN_LABEL, ApiError } from '../cloud/api';
import { PLANS, TRIAL, type PlanId } from '../../shared/plans.mjs';
import { formatBRL } from '../lib/money';
import { IBell, ICloud, IShield, ICheck, IFace, ILock, IHelp } from '../ui/icons';
import { Logo } from '../ui/Logo';
import { HelpContent } from './Help';
import { Pricing, PackCard, sourceLabel } from './Billing';
import { isNative, platform } from '../native/platform';
import { manageSubscriptions } from '../native/iap';
import { deleteAccountRemote } from '../cloud/api';
import { biometricAvailable, biometricLabel, enrollBiometric, BiometricError } from '../cloud/biometric';
import { REMEMBER_DAYS } from '../cloud/session';

const fmtDate = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : '');
const brl = (v: number) => formatBRL(Math.round(v * 100));

function b64uToBytes(s: string): Uint8Array {
  const p = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(p + '='.repeat((4 - (p.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

const pushSupported = () => typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const isIOS = () => typeof navigator !== 'undefined' && /iPhone|iPad|iPod/.test(navigator.userAgent);
const standalone = () => typeof window !== 'undefined' && (window.matchMedia?.('(display-mode: standalone)').matches || (navigator as any).standalone === true);

function useRunner() {
  const fb = useFeedback();
  const [busy, setBusy] = useState<string | null>(null);
  const run = async <T,>(label: string, fn: () => Promise<T>): Promise<T | undefined> => {
    setBusy(label);
    try {
      return await fn();
    } catch (e) {
      fb.toast(e instanceof AuthError || e instanceof ApiError ? e.message : tr('出错：{0}', (e as Error).message), { bad: true });
      return undefined;
    } finally {
      setBusy(null);
    }
  };
  return { busy, run };
}

/* ---------------- 登录 / 注册 ---------------- */

const LAST_EMAIL = 'zq.lastEmail';
const readLastEmail = () => {
  try {
    return localStorage.getItem(LAST_EMAIL) ?? '';
  } catch {
    return '';
  }
};

export function LoginForm({ compact = false }: { compact?: boolean }) {
  const { cloud, auth, signIn, sync, go } = useStore();
  const fb = useFeedback();
  const { busy, run } = useRunner();
  const last = readLastEmail();
  const [email, setEmail] = useState(auth.session?.user.email ?? last);
  const [password, setPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [method, setMethod] = useState<'password' | 'code'>('password');
  const [forgot, setForgot] = useState(false);
  // 这台设备登录过 → 默认「登录」；第一次来 → 默认「注册」
  const [mode, setMode] = useState<'signup' | 'login'>(last ? 'login' : 'signup');
  const [code, setCode] = useState('');
  const [sent, setSent] = useState(false);
  const [cooldown, setCooldown] = useState(0);

  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  if (!cloud) return null;
  const remember = (e: string) => {
    try {
      localStorage.setItem(LAST_EMAIL, e);
    } catch {}
  };
  const doPassword = () =>
    run(mode === 'signup' ? tr('注册中…') : tr('登录中…'), async () => {
      const s = mode === 'signup' ? await signUpPassword(cloud, email, password) : await signInPassword(cloud, email, password);
      remember(s.user.email);
      await signIn(s);
      setPassword('');
      if (mode === 'signup') fb.celebrate();
      fb.toast(mode === 'signup' ? tr('注册成功，已登录 {0}', s.user.email) : tr('已登录 {0}，账单开始同步', s.user.email));
    });
  const canSubmit = isEmail(email) && (mode === 'signup' ? password.length >= 8 : !!password);

  return (
    <div className="stack loginform">
      {auth.error && <div className="banner bad small">{tx(auth.error)}</div>}
      {!compact && sync.config && !sync.config.account && <p className="xs muted">{tr('登录后会改用账号同步，本机所有账单会上传到账号（示例数据不上传）。')}</p>}
      {method === 'password' && (
        <div className="authtabs" role="tablist" aria-label={tr('登录或注册')}>
          <button role="tab" aria-selected={mode === 'login'} onClick={() => setMode('login')}>
            {tr('登录')}
          </button>
          <button role="tab" aria-selected={mode === 'signup'} onClick={() => setMode('signup')}>
            {tr('注册')}
          </button>
          <span className="authtabs-ink" data-pos={mode} aria-hidden="true" />
        </div>
      )}
      {method === 'code' && <h2 className="authtitle">{forgot ? tr('忘记密码') : tr('邮箱验证码登录')}</h2>}
      {method === 'code' && forgot && <p className="small muted">{tr('先用邮件验证码登录，登录后在「账号与套餐 → 登录密码」设置新密码。')}</p>}
      <div className="field">
        <label htmlFor="acc-email">{tr('邮箱')}</label>
        <input id="acc-email" className="input" type="email" inputMode="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
      </div>
      {method === 'password' ? (
        <>
          <div className="field">
            <label htmlFor="acc-pw">{tr('密码')}</label>
            <div className="datefield">
              <input
                id="acc-pw"
                className="input"
                type={showPw ? 'text' : 'password'}
                autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && canSubmit && doPassword()}
                placeholder={mode === 'signup' ? tr('设置密码，至少 8 位') : tr('你的密码')}
              />
              <button type="button" className="btn datebtn" aria-label={showPw ? tr('隐藏密码') : tr('显示密码')} onClick={() => setShowPw((v) => !v)}>
                {showPw ? tr('藏') : tr('看')}
              </button>
            </div>
          </div>
          <button className="btn btn-primary btn-lg btn-block" disabled={!!busy || !canSubmit} onClick={doPassword}>
            {busy ? <span className="spin" /> : null}
            {mode === 'signup' ? tr('注册，免费试用 {0} 天', TRIAL.days) : tr('登录')}
          </button>
          <p className="xs muted rememberline">
            <IShield width={14} height={14} /> {tr('这台设备会被记住，至少半年不用再登录')}
          </p>
          <div className="row" style={{ justifyContent: 'center', gap: 18 }}>
            <button type="button" className="linkbtn small" onClick={() => setMethod('code')}>
              {tr('用邮箱验证码登录')}
            </button>
            {mode === 'login' && (
              <button
                type="button"
                className="linkbtn small"
                onClick={() => {
                  setForgot(true);
                  setMethod('code');
                }}
              >
                {tr('忘记密码？')}
              </button>
            )}
          </div>
        </>
      ) : (
        <>
          {sent && (
            <div className="field">
              <label htmlFor="acc-code">{tr('邮件里的验证码')}</label>
              <input id="acc-code" className="input mono num" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 10))} placeholder={tr('6 位数字')} />
              <span className="hint">{tr('没收到？看看垃圾邮件；')}{cooldown > 0 ? tr('{0} 秒后可重发', cooldown) : tr('可以重新发送')}{tr('。')}</span>
            </div>
          )}
          <div className="row">
            {!sent || cooldown <= 0 ? (
              <button
                className={`btn ${sent ? '' : 'btn-primary'}`}
                disabled={!!busy || !isEmail(email)}
                onClick={() =>
                  run(tr('发送中…'), async () => {
                    await sendCode(cloud, email);
                    setSent(true);
                    setCooldown(60);
                    fb.toast(tr('验证码已发送到邮箱'));
                  })
                }
              >
                {busy === '发送中…' ? <span className="spin" /> : null}
                {sent ? tr('重新发送') : tr('发送验证码')}
              </button>
            ) : null}
            {sent && (
              <button
                className="btn btn-primary"
                disabled={!!busy || code.length < 6}
                onClick={() =>
                  run(tr('登录中…'), async () => {
                    const s = await verifyCode(cloud, email, code);
                    remember(s.user.email);
                    await signIn(s);
                    if (forgot) {
                      fb.toast(tr('已登录，现在设置新密码'));
                      go({ name: 'account' });
                      setTimeout(() => document.getElementById('h-pw')?.closest('details')?.setAttribute('open', ''), 400);
                    } else fb.toast(tr('已登录 {0}，账单开始同步', s.user.email));
                  })
                }
              >
                {busy === '登录中…' ? <span className="spin" /> : null}
                {tr('登录')}
              </button>
            )}
          </div>
          <button
            type="button"
            className="linkbtn small"
            style={{ alignSelf: 'center' }}
            onClick={() => {
              setForgot(false);
              setMethod('password');
            }}
          >
            {tr('用密码登录')}
          </button>
        </>
      )}
    </div>
  );
}

/* ---------------- 套餐 ---------------- */

const FEATURE_TEXT: Record<Feature, { title: string; body: string }> = {
  edit: { title: tr('试用已结束'), body: tr('账单仍然可以查看、标记已付。新增、编辑、识别单据需要订阅 T1 或 T2。数据都还在，订阅后立即恢复。') },
  push: { title: tr('关屏推送是 T1 / T2 的功能'), body: tr('订阅后，每天 09:00 把要付和已逾期的账单推送到手机，不用打开应用。') },
  export: { title: tr('导出记录是 T2 的功能'), body: tr('订阅 T2 后可以把账单和流水导出为 CSV（Excel 可直接打开），方便记账和对账。') },
};

/** 没有权限时的订阅弹窗（由 App 根据 store.paywall 显示） */
export function PaywallModal() {
  const { paywall, closePaywall, go } = useStore();
  if (!paywall) return null;
  const t = FEATURE_TEXT[paywall];
  return (
    <Modal title={t.title} onClose={closePaywall}>
      <p className="small">{t.body}</p>
      <Pricing />
      <div className="row end">
        <button className="btn btn-ghost" onClick={closePaywall}>
          {tr('以后再说')}
        </button>
        <button
          className="btn btn-soft"
          onClick={() => {
            closePaywall();
            go({ name: 'account' });
          }}
        >
          {tr('账号与套餐')}
        </button>
      </div>
    </Modal>
  );
}

/** 只读时替代新增/编辑/识别页面 */
export function ReadOnlyPage() {
  const { go } = useStore();
  return (
    <section className="card stack">
      <h2 className="row">
        <IShield width={20} height={20} /> {FEATURE_TEXT.edit.title}
      </h2>
      <p className="small">{FEATURE_TEXT.edit.body}</p>
      <Pricing />
      <button className="btn btn-ghost" style={{ alignSelf: 'flex-start' }} onClick={() => go({ name: 'bills' })}>
        {tr('查看账单')}
      </button>
    </section>
  );
}

/** 首页顶部：试用剩余 / 已到期 */
export function PlanBanner() {
  const { ent, gate, go, auth } = useStore();
  if (!gate.saas || !ent) return null;
  const u = auth.account?.usage;
  if (ent.plan === 'expired')
    return (
      <div className="banner bad">
        <span className="grow small">
          <b>{tr('试用已结束')}</b>{tr('，账单只读。订阅后立即恢复全部功能。')}
        </span>
        <button className="btn btn-sm btn-primary" onClick={() => go({ name: 'account' })}>
          {tr('订阅')}
        </button>
      </div>
    );
  if (ent.plan !== 'trial') return null;
  const left = ent.daysLeft ?? 0;
  return (
    <div className={`banner ${left <= 7 ? 'warn' : 'ok'}`}>
      <span className="grow small">
        {tr('免费试用还剩')} <b>{left} {tr('天')}</b>
        {u && u.limit > 0 ? tr(' · AI 识别剩 {0} 次', Math.max(0, u.limit - u.ai)) : ''}
      </span>
      <button className="btn btn-sm" onClick={() => go({ name: 'account' })}>
        {tr('查看套餐')}
      </button>
    </div>
  );
}

/* ---------------- 账号页 ---------------- */

export function AccountPage() {
  const { cloud, auth, signOut, refreshAccount, getToken, go, ent } = useStore();
  const fb = useFeedback();
  const { busy, run } = useRunner();
  const acc = auth.account;

  // 从 Mercado Pago 付款页回来：刷新套餐
  useEffect(() => {
    const q = new URLSearchParams(location.search);
    if (!q.has('mp')) return;
    history.replaceState(null, '', location.pathname + location.hash);
    void refreshAccount().then((a) => {
      if (!a) return;
      const ok = a.plan === 't1' || a.plan === 't2';
      if (ok) fb.celebrate();
      fb.toast(ok ? tr('已开通 {0}，感谢支持！', PLAN_LABEL[a.plan as PlanId]) : tr('正在等待 Mercado Pago 确认付款，几分钟后点「刷新」'));
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (!cloud) {
    return (
      <section className="card stack">
        <h2 className="row">
          <ICloud width={20} height={20} /> {tr('账号')}
        </h2>
        <p className="small">{tr('这个网站还没有连接账号服务。管理员请按 README「一键部署」完成初始化。')}</p>
        <button className="btn btn-primary" style={{ alignSelf: 'flex-start' }} onClick={() => go({ name: 'set-dev' })}>
          {tr('去设置')}
        </button>
      </section>
    );
  }

  if (!auth.session) {
    return (
      <section className="card stack" aria-labelledby="h-login">
        <h2 id="h-login" className="row">
          <ICloud width={20} height={20} /> {tr('登录账号')}
        </h2>
        <p className="small">{tr('登录后账单在你所有设备间自动同步。新账号免费试用')} {TRIAL.days} {tr('天，含')} {TRIAL.ai} {tr('次 AI 识别。')}</p>
        <LoginForm />
      </section>
    );
  }

  const plan = ent?.plan ?? acc?.plan ?? 'trial';
  const usage = acc?.usage;
  const pct = usage && usage.limit > 0 ? Math.min(100, Math.round((usage.ai / usage.limit) * 100)) : 0;
  const sub = acc?.subscription?.status ?? null;

  return (
    <>
      <section className="card stack" aria-labelledby="h-acc">
        <div className="row between">
          <h2 id="h-acc" className="row">
            <ICloud width={20} height={20} /> {auth.session.user.email}
          </h2>
          <span className={`pill ${plan === 'expired' ? 'overdue' : plan === 'trial' ? 'dueSoon' : 'paid'}`}>{PLAN_LABEL[plan]}</span>
        </div>
        {auth.error && <div className="banner bad small">{tx(auth.error)}</div>}
        <p className="small">
          {plan === 'trial' && <>{tr('免费试用到')} <b>{fmtDate(ent?.trialUntil ?? null)}</b>{tr('（还剩')} {ent?.daysLeft ?? '?'} {tr('天）。')}</>}
          {plan === 'expired' && <>{tr('试用已结束，账单只读。订阅后立即恢复。')}</>}
          {(plan === 't1' || plan === 't2') && (
            <>
              {PLAN_LABEL[plan]}{tr('（')}{ent?.period === 'year' ? tr('年付') : tr('月付')}{tr('）有效期至')} <b>{fmtDate(ent?.planUntil ?? null)}</b>
              {acc?.autoRenew ? tr('，到期自动续费。') : acc?.source === 'pix' ? tr('（PIX 年付，不自动续费）。') : sub === 'cancelled' || acc?.autoRenew === false ? tr('，已取消自动续费。') : tr('。')}
              {acc?.source && (!isNative() || acc.source === (platform() === 'ios' ? 'apple' : 'google')) && <span className="xs muted"> {tr('来自')}{sourceLabel(acc.source)}{tr('。')}</span>}
            </>
          )}
          {plan === 'owner' && <>{tr('管理员：全部功能、不限次数。')}</>}
        </p>
        {usage && usage.limit !== 0 && (
          <div className="stack" style={{ gap: 4 }}>
            <div className="row between small">
              <span>{usage.period === 'trial' ? tr('试用期 AI 识别') : tr('本月 AI 识别')}</span>
              <b className="num">{usage.limit < 0 ? tr('{0} 次（不限）', usage.ai) : tr('{0} / {1} 次', usage.ai, usage.limit)}</b>
            </div>
            {usage.limit > 0 && (
              <div className={`meter${pct >= 90 ? ' bad' : ''}`} role="progressbar" aria-valuenow={usage.ai} aria-valuemin={0} aria-valuemax={usage.limit}>
                <div style={{ width: `${pct}%` }} />
              </div>
            )}
            {!!usage.bonus && (
              <div className="row between small">
                <span>{tr('AI 加量包剩余')}</span>
                <b className="num">{usage.bonus} {tr('次')}</b>
              </div>
            )}
            <span className="xs muted">{usage.period === 'trial' ? tr('试用期共 ') + TRIAL.ai + tr(' 次。') : tr('每月 1 日重置。')}{tr('用完后自动用加量包。识别失败不计次数；PDF 直接读文字、本机 OCR 都不占次数。')}</span>
          </div>
        )}
        <div className="row">
          <button className="btn btn-sm" disabled={!!busy} onClick={() => run(tr('刷新…'), refreshAccount)}>
            {tr('刷新')}
          </button>
          {isNative() && acc?.autoRenew && acc.source === (platform() === 'ios' ? 'apple' : 'google') && (
            <button className="btn btn-sm btn-ghost" onClick={() => void manageSubscriptions().catch(() => {})}>
              {tr('管理订阅')}
            </button>
          )}
          {!isNative() && sub === 'authorized' && (acc?.source ?? 'mp') === 'mp' && (
            <button
              className="btn btn-sm btn-ghost"
              disabled={!!busy}
              onClick={async () => {
                const ok = await fb.confirm({ title: tr('取消自动续费？'), body: tr('已付的期间照常可用，到 {0} 后变为只读（数据保留）。', fmtDate(ent?.planUntil ?? null)), confirmLabel: tr('取消续费'), danger: true });
                if (!ok) return;
                const r = await run(tr('取消中…'), async () => {
                  const token = await getToken();
                  if (!token) throw new ApiError(401, tr('请重新登录'));
                  return cancelSubscription(cloud, token);
                });
                if (r) {
                  fb.toast(tr('已取消自动续费'));
                  void refreshAccount();
                }
              }}
            >
              {tr('取消自动续费')}
            </button>
          )}
          <button
            className="btn btn-sm btn-ghost"
            onClick={async () => {
              const ok = await fb.confirm({ title: tr('退出登录？'), body: tr('本机的账单会保留，只是不再同步。重新登录同一个账号即可继续。'), confirmLabel: tr('退出') });
              if (ok) {
                await signOut();
                fb.toast(tr('已退出登录'));
              }
            }}
          >
            {tr('退出登录')}
          </button>
        </div>
      </section>

      {plan !== 'owner' && (
        <section className="card stack" aria-labelledby="h-plan">
          <h2 id="h-plan" className="row">
            <IShield width={20} height={20} /> {tr('套餐')}
          </h2>
          {acc?.subscription?.plan && sub === 'authorized' && acc.subscription.plan !== plan && <p className="xs muted">{tr('正在切换到')} {PLAN_LABEL[acc.subscription.plan as PlanId] ?? acc.subscription.plan}{tr('，付款确认后自动生效并取消原订阅。')}</p>}
          <Pricing />
        </section>
      )}
      <PackCard />

      <DeviceSection />
      <PushSection />
      <PasswordSection />
      <DeleteAccount />
    </>
  );
}

/** 登录密码：设置或修改（忘记密码时先用验证码登录再来这里） */
function PasswordSection() {
  const { cloud, getToken } = useStore();
  const fb = useFeedback();
  const { busy, run } = useRunner();
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [show, setShow] = useState(false);
  const ok = pw.length >= 8 && pw === pw2;
  const save = () =>
    run(tr('保存中…'), async () => {
      if (!cloud) throw new ApiError(0, tr('没有连接服务'));
      const token = await getToken();
      if (!token) throw new ApiError(401, tr('请重新登录'));
      await setPassword(cloud, token, pw);
      setPw('');
      setPw2('');
      fb.toast(tr('新密码已保存，下次可以用密码登录'));
    });
  return (
    <section className="card stack" aria-labelledby="h-pw">
      <details className="more">
        <summary id="h-pw">{tr('登录密码')}</summary>
        <div className="stack" style={{ marginTop: 8 }}>
          <p className="small muted">{tr('设置或修改密码。用验证码登录的账号也可以在这里加一个密码。')}</p>
          <div className="field">
            <label htmlFor="pw-new">{tr('新密码')}</label>
            <input id="pw-new" className="input" type={show ? 'text' : 'password'} autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} placeholder={tr('至少 8 位')} />
          </div>
          <div className="field">
            <label htmlFor="pw-new2">{tr('再输一次')}</label>
            <input id="pw-new2" className="input" type={show ? 'text' : 'password'} autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && ok && save()} />
            {pw2 && pw !== pw2 && <span className="hint">{tr('两次输入不一样')}</span>}
          </div>
          <div className="row">
            <button className="btn btn-primary" disabled={!!busy || !ok} onClick={save}>
              {busy ? <span className="spin" /> : null}
              {tr('保存新密码')}
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => setShow((v) => !v)}>
              {show ? tr('隐藏') : tr('显示')}
            </button>
          </div>
        </div>
      </details>
    </section>
  );
}

/** 删除账号（App Store / Google Play 要求 App 内能删除） */
function DeleteAccount() {
  const { cloud, auth, getToken, signOut, repo, reload } = useStore();
  const fb = useFeedback();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const { busy, run } = useRunner();
  const email = auth.session?.user.email ?? '';
  const acc = auth.account;
  const storeSub = acc?.subs?.some((x) => (x.source === 'apple' || x.source === 'google') && x.autoRenew);
  const doDelete = () =>
    run(tr('删除中…'), async () => {
      if (!cloud) throw new ApiError(0, tr('没有连接服务'));
      const token = await getToken();
      if (!token) throw new ApiError(401, tr('请重新登录'));
      const r = await deleteAccountRemote(cloud, token, text.trim().toLowerCase());
      await signOut();
      await repo.clearAll();
      await reload();
      setOpen(false);
      fb.toast(r.cancelInStore.length ? tr('账号已删除。别忘了到 {0} 取消自动续订', r.cancelInStore.map((x) => (x === 'apple' ? 'App Store' : 'Google Play')).join(tr('、'))) : tr('账号和数据已全部删除'));
    });
  return (
    <section className="card stack" aria-labelledby="h-del">
      <details className="more" onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
        <summary id="h-del">{tr('删除账号')}</summary>
        {open && (
          <div className="stack" style={{ marginTop: 8 }}>
            <p className="small">
              {tr('将永久删除这个账号、云端的全部账单和识别记录，以及这台设备上的数据，无法恢复。需要的话先到「数据管理」导出备份。')}
              {storeSub && <b> {tr('在 App Store / Google Play 买的订阅不会自动停止扣费，请到商店的订阅管理里取消。')}</b>}
              {acc?.source === 'mp' && acc.autoRenew && tr(' 网页的自动续费会一起取消。')}
            </p>
            <div className="field">
              <label htmlFor="del-confirm">{tr('输入你的邮箱')} {email} {tr('确认')}</label>
              <input id="del-confirm" className="input" type="email" autoComplete="off" value={text} onChange={(e) => setText(e.target.value)} placeholder={email} />
            </div>
            <button className="btn btn-danger" style={{ alignSelf: 'flex-start' }} disabled={!!busy || text.trim().toLowerCase() !== email.toLowerCase()} onClick={doDelete}>
              {busy ? <span className="spin" /> : null}
              {tr('永久删除账号')}
            </button>
          </div>
        )}
      </details>
    </section>
  );
}

function PushSection() {
  const { cloud, getToken, gate, requireFeature } = useStore();
  const fb = useFeedback();
  const [state, setState] = useState<'checking' | 'unsupported' | 'off' | 'on' | 'denied'>('checking');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!pushSupported()) return setState('unsupported');
    if (Notification.permission === 'denied') return setState('denied');
    navigator.serviceWorker
      .getRegistration()
      .then(async (reg) => setState((await reg?.pushManager.getSubscription()) ? 'on' : 'off'))
      .catch(() => setState('off'));
  }, []);

  const enable = async () => {
    if (!cloud || !requireFeature('push')) return;
    setBusy(true);
    try {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') {
        setState(perm === 'denied' ? 'denied' : 'off');
        return;
      }
      const reg = (await navigator.serviceWorker.getRegistration()) ?? (await navigator.serviceWorker.ready);
      const { publicKey } = await pushKey(cloud);
      const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uToBytes(publicKey) as BufferSource }));
      const token = await getToken();
      if (!token) throw new ApiError(401, tr('请重新登录'));
      await pushSubscribe(cloud, token, sub.toJSON());
      setState('on');
      fb.toast(tr('已开启关屏推送'));
    } catch (e) {
      fb.toast(e instanceof ApiError ? e.message : tr('开启失败：{0}', (e as Error).message), { bad: true });
    } finally {
      setBusy(false);
    }
  };

  const disable = async () => {
    if (!cloud) return;
    setBusy(true);
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      const sub = await reg?.pushManager.getSubscription();
      const token = await getToken();
      if (sub && token) await pushUnsubscribe(cloud, token, sub.endpoint).catch(() => {});
      await sub?.unsubscribe();
      setState('off');
      fb.toast(tr('已关闭关屏推送'));
    } finally {
      setBusy(false);
    }
  };

  const test = async () => {
    if (!cloud) return;
    setBusy(true);
    try {
      const token = await getToken();
      if (!token) throw new ApiError(401, tr('请重新登录'));
      const r = await pushTest(cloud, token);
      fb.toast(r.sent ? tr('已发送测试推送（{0} 台设备）', r.sent) : tr('没有发出去：请关闭后重新开启推送'), { bad: !r.sent });
    } catch (e) {
      fb.toast((e as Error).message, { bad: true });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card stack" aria-labelledby="h-push">
      <h2 id="h-push" className="row">
        <IBell width={20} height={20} /> {tr('关屏推送提醒')} {!gate.canPush && <span className="pill neutral">T1 / T2</span>}
      </h2>
      <p className="small">{tr('每天圣保罗时间 09:00 左右，把要付和已逾期的账单推送到这台设备，不用打开应用。')}</p>
      {state === 'unsupported' && <p className="small err">{isIOS() && !standalone() ? tr('iPhone 需要先把本应用「添加到主屏幕」，再从主屏幕打开，才能开启推送。') : tr('这个浏览器不支持网页推送，可以用日历提醒。')}</p>}
      {state === 'denied' && <p className="small err">{tr('通知权限被拒绝：请在浏览器的网站设置里改为「允许」后再开启。')}</p>}
      <div className="row">
        {state === 'off' && (
          <button className="btn btn-primary" disabled={busy} onClick={enable}>
            {busy ? <span className="spin" /> : <IBell />}
            {tr('开启推送')}
          </button>
        )}
        {state === 'on' && (
          <>
            <span className="pill paid">{tr('已开启')}</span>
            <button className="btn btn-sm" disabled={busy} onClick={test}>
              {tr('发一条测试')}
            </button>
            <button className="btn btn-sm btn-ghost" disabled={busy} onClick={disable}>
              {tr('关闭')}
            </button>
          </>
        )}
      </div>
    </section>
  );
}

/** 公开部署时，未登录先看到这里（介绍 + 注册登录） */
export function Welcome() {
  const [help, setHelp] = useState(false);
  const [prices, setPrices] = useState(false);
  return (
    <div className="authpage">
      <div className="authhero">
        <div className="authbrand">
          <Logo size={34} /> {tr('账期助手')}
        </div>
        <h1>
          {tr('账期和缴费，')}
          <br />
          {tr('到期前提醒你')}
        </h1>
        <p>{tr('拍照识别单据 · 自动算到期日 · 手机电脑同步')}</p>
        <HeroArt />
      </div>
      <div className="authpanel">
        <section className="card authcard">
          <LoginForm compact />
        </section>
        <ul className="perks small">
          {[tr('拍照或 PDF 识别订单、boleto、水电税费单'), tr('按商家账期自动算到期日，逾期一目了然'), tr('对账单导入、每月流水、多设备同步'), tr('新账号免费试用 {0} 天，含 {1} 次 AI 识别', TRIAL.days, TRIAL.ai)].map((t, i) => (
            <li key={t} style={{ animationDelay: `${0.15 + i * 0.07}s` }}>
              <ICheck width={16} height={16} /> {t}
            </li>
          ))}
        </ul>
        <div className="row" style={{ justifyContent: 'center', gap: 4 }}>
          <button className="btn btn-ghost btn-sm" onClick={() => setHelp(true)}>
            <IHelp width={16} height={16} /> {tr('使用教程')}
          </button>
          <button className="btn btn-ghost btn-sm" onClick={() => setPrices(true)}>
            {tr('套餐与价格')}
          </button>
        </div>
      </div>
      {prices && (
        <Modal title={tr('套餐与价格')} onClose={() => setPrices(false)}>
          <div className="stack">
            <p className="small muted">
              {tr('新账号免费试用')} {TRIAL.days} {tr('天，含')} {TRIAL.ai} {tr('次 AI 识别。试用结束后可订阅：')}
            </p>
            {(['t1', 't2'] as PlanId[]).map((p) => (
              <div key={p} className="card stack" style={{ gap: 4 }}>
                <b>
                  {PLANS[p].name} · {brl(PLANS[p].month)}{tr('/月 ·')} {brl(PLANS[p].year)}{tr('/年')}
                </b>
                <span className="small muted">
                  {tr('关屏推送、AI 识别')} {PLANS[p].ai} {tr('次/月')}{PLANS[p].export ? tr('、CSV / Excel 导出') : ''}
                </span>
              </div>
            ))}
            <p className="xs muted">{isNative() ? tr('通过 {0} 订阅，可随时取消。', platform() === 'ios' ? 'App Store' : 'Google Play') : tr('网页可用信用卡自动续费或 PIX 一次付清一年；手机 App 里也能订阅。')}{tr('没订阅时账单仍可查看和备份。')}</p>
          </div>
        </Modal>
      )}
      {help && (
        <Modal title={tr('使用教程')} onClose={() => setHelp(false)}>
          <HelpContent compact />
        </Modal>
      )}
    </div>
  );
}

/** 登录页右上的小动画：单据扫描 → 生成账单 → 标记已付 */
function HeroArt() {
  return (
    <div className="heroart" aria-hidden="true">
      <div className="ha-doc">
        <i />
        <i />
        <i style={{ width: '60%' }} />
        <i />
        <i style={{ width: '45%' }} />
        <span className="ha-scan" />
      </div>
      <div className="ha-bill">
        <span className="ha-av">L</span>
        <span className="grow">
          <b>Loja Exemplo</b>
          <small>{tr('3 天后到期')}</small>
        </span>
        <b>R$ 368,00</b>
      </div>
      <div className="ha-paid">
        <ICheck width={16} height={16} /> {tr('已付')}
      </div>
    </div>
  );
}

/** 设备与安全：记住设备 + 面容 ID / 指纹解锁 */
function DeviceSection() {
  const { auth, lock, setBiometric, lockNow } = useStore();
  const fb = useFeedback();
  const [avail, setAvail] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const label = biometricLabel();
  useEffect(() => {
    void biometricAvailable().then(setAvail);
  }, []);
  const user = auth.session?.user;
  const on = !!lock.cfg;

  const toggle = async () => {
    if (!user) return;
    if (on) {
      const ok = await fb.confirm({ title: tr('关闭{0}解锁？', label), body: tr('关闭后打开应用不再需要验证，账号仍保持登录。'), confirmLabel: tr('关闭') });
      if (ok) {
        await setBiometric(null);
        fb.toast(tr('已关闭{0}解锁', label));
      }
      return;
    }
    setBusy(true);
    try {
      const cfg = await enrollBiometric(user);
      await setBiometric(cfg);
      fb.toast(tr('已开启：以后打开应用用{0}解锁', label));
    } catch (e) {
      fb.toast(e instanceof BiometricError ? e.message : tr('开启失败：{0}', (e as Error).message), { bad: true });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card stack" aria-labelledby="h-device">
      <h2 id="h-device" className="row">
        <ILock width={20} height={20} /> {tr('设备与安全')}
      </h2>
      <div className="row" style={{ alignItems: 'flex-start', flexWrap: 'nowrap', gap: 10 }}>
        <span className="okdot" aria-hidden="true">
          <ICheck width={14} height={14} />
        </span>
        <span className="small">
          <b>{tr('已记住这台设备')}</b>{tr('：登录一次在本机长期有效（至少')} {REMEMBER_DAYS} {tr('天），关掉浏览器、重启手机都不用重新登录。手机上建议「添加到主屏幕」，打开更快、也更不容易被系统清理。')}
        </span>
      </div>
      {avail === false && <p className="xs muted">{tr('这台设备或浏览器不支持')}{label}{tr('解锁（需要面容 / 指纹硬件和 https 网址）。')}</p>}
      {avail && (
        <>
          <label className="switchrow">
            <span className="grow stack" style={{ gap: 2 }}>
              <b className="small row" style={{ gap: 6 }}>
                <IFace width={18} height={18} /> {tr('打开应用时用')}{label}{tr('解锁')}
              </b>
              <span className="xs muted">{tr('别人拿到你的手机也看不到账单。离开应用超过 5 分钟回来会重新验证。生物信息只在本机芯片里，不会上传。')}</span>
            </span>
            <input type="checkbox" role="switch" className="switch" checked={on} disabled={busy} onChange={toggle} aria-label={tr('打开应用时用{0}解锁', label)} />
          </label>
          {on && (
            <button className="btn btn-sm btn-ghost" style={{ alignSelf: 'flex-start' }} onClick={lockNow}>
              <ILock width={16} height={16} /> {tr('立即锁定')}
            </button>
          )}
        </>
      )}
    </section>
  );
}

