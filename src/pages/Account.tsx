import { useEffect, useState } from 'react';
import { useStore, type Feature } from '../store';
import { useFeedback, Modal } from '../ui/feedback';
import { sendCode, verifyCode, isEmail, AuthError, signInPassword, signUpPassword } from '../cloud/auth';
import { startCheckout, cancelSubscription, pushKey, pushSubscribe, pushUnsubscribe, pushTest, PLAN_LABEL, ApiError } from '../cloud/api';
import { PLANS, TRIAL, type PlanId, type Period } from '../../shared/plans.mjs';
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
      fb.toast(e instanceof AuthError || e instanceof ApiError ? e.message : `出错：${(e as Error).message}`, { bad: true });
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
  const { cloud, auth, signIn, sync } = useStore();
  const fb = useFeedback();
  const { busy, run } = useRunner();
  const last = readLastEmail();
  const [email, setEmail] = useState(auth.session?.user.email ?? last);
  const [password, setPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [method, setMethod] = useState<'password' | 'code'>('password');
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
    run(mode === 'signup' ? '注册中…' : '登录中…', async () => {
      const s = mode === 'signup' ? await signUpPassword(cloud, email, password) : await signInPassword(cloud, email, password);
      remember(s.user.email);
      await signIn(s);
      setPassword('');
      if (mode === 'signup') fb.celebrate();
      fb.toast(mode === 'signup' ? `注册成功，已登录 ${s.user.email}` : `已登录 ${s.user.email}，账单开始同步`);
    });
  const canSubmit = isEmail(email) && (mode === 'signup' ? password.length >= 8 : !!password);

  return (
    <div className="stack loginform">
      {auth.error && <div className="banner bad small">{auth.error}</div>}
      {!compact && sync.config && !sync.config.account && <p className="xs muted">登录后会改用账号同步，本机所有账单会上传到账号（示例数据不上传）。</p>}
      {method === 'password' && (
        <div className="authtabs" role="tablist" aria-label="登录或注册">
          <button role="tab" aria-selected={mode === 'login'} onClick={() => setMode('login')}>
            登录
          </button>
          <button role="tab" aria-selected={mode === 'signup'} onClick={() => setMode('signup')}>
            注册
          </button>
          <span className="authtabs-ink" data-pos={mode} aria-hidden="true" />
        </div>
      )}
      {method === 'code' && <h2 className="authtitle">邮箱验证码登录</h2>}
      <div className="field">
        <label htmlFor="acc-email">邮箱</label>
        <input id="acc-email" className="input" type="email" inputMode="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
      </div>
      {method === 'password' ? (
        <>
          <div className="field">
            <label htmlFor="acc-pw">密码</label>
            <div className="datefield">
              <input
                id="acc-pw"
                className="input"
                type={showPw ? 'text' : 'password'}
                autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && canSubmit && doPassword()}
                placeholder={mode === 'signup' ? '设置密码，至少 8 位' : '你的密码'}
              />
              <button type="button" className="btn datebtn" aria-label={showPw ? '隐藏密码' : '显示密码'} onClick={() => setShowPw((v) => !v)}>
                {showPw ? '藏' : '看'}
              </button>
            </div>
          </div>
          <button className="btn btn-primary btn-lg btn-block" disabled={!!busy || !canSubmit} onClick={doPassword}>
            {busy ? <span className="spin" /> : null}
            {mode === 'signup' ? `注册，免费试用 ${TRIAL.days} 天` : '登录'}
          </button>
          <p className="xs muted rememberline">
            <IShield width={14} height={14} /> 这台设备会被记住，至少半年不用再登录
          </p>
          <button type="button" className="linkbtn small" style={{ alignSelf: 'center' }} onClick={() => setMethod('code')}>
            用邮箱验证码登录
          </button>
        </>
      ) : (
        <>
          {sent && (
            <div className="field">
              <label htmlFor="acc-code">邮件里的验证码</label>
              <input id="acc-code" className="input mono num" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 10))} placeholder="6 位数字" />
              <span className="hint">没收到？看看垃圾邮件；{cooldown > 0 ? `${cooldown} 秒后可重发` : '可以重新发送'}。</span>
            </div>
          )}
          <div className="row">
            {!sent || cooldown <= 0 ? (
              <button
                className={`btn ${sent ? '' : 'btn-primary'}`}
                disabled={!!busy || !isEmail(email)}
                onClick={() =>
                  run('发送中…', async () => {
                    await sendCode(cloud, email);
                    setSent(true);
                    setCooldown(60);
                    fb.toast('验证码已发送到邮箱');
                  })
                }
              >
                {busy === '发送中…' ? <span className="spin" /> : null}
                {sent ? '重新发送' : '发送验证码'}
              </button>
            ) : null}
            {sent && (
              <button
                className="btn btn-primary"
                disabled={!!busy || code.length < 6}
                onClick={() =>
                  run('登录中…', async () => {
                    const s = await verifyCode(cloud, email, code);
                    remember(s.user.email);
                    await signIn(s);
                    fb.toast(`已登录 ${s.user.email}，账单开始同步`);
                  })
                }
              >
                {busy === '登录中…' ? <span className="spin" /> : null}
                登录
              </button>
            )}
          </div>
          <button type="button" className="linkbtn small" style={{ alignSelf: 'center' }} onClick={() => setMethod('password')}>
            用密码登录
          </button>
        </>
      )}
    </div>
  );
}

/* ---------------- 套餐 ---------------- */

const FEATURE_TEXT: Record<Feature, { title: string; body: string }> = {
  edit: { title: '试用已结束', body: '账单仍然可以查看、标记已付。新增、编辑、识别单据需要订阅 T1 或 T2。数据都还在，订阅后立即恢复。' },
  push: { title: '关屏推送是 T1 / T2 的功能', body: '订阅后，每天 09:00 把要付和已逾期的账单推送到手机，不用打开应用。' },
  export: { title: '导出记录是 T2 的功能', body: '订阅 T2 后可以把账单和流水导出为 CSV（Excel 可直接打开），方便记账和对账。' },
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
          以后再说
        </button>
        <button
          className="btn btn-soft"
          onClick={() => {
            closePaywall();
            go({ name: 'account' });
          }}
        >
          账号与套餐
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
        查看账单
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
          <b>试用已结束</b>，账单只读。订阅后立即恢复全部功能。
        </span>
        <button className="btn btn-sm btn-primary" onClick={() => go({ name: 'account' })}>
          订阅
        </button>
      </div>
    );
  if (ent.plan !== 'trial') return null;
  const left = ent.daysLeft ?? 0;
  return (
    <div className={`banner ${left <= 7 ? 'warn' : 'ok'}`}>
      <span className="grow small">
        免费试用还剩 <b>{left} 天</b>
        {u && u.limit > 0 ? ` · AI 识别剩 ${Math.max(0, u.limit - u.ai)} 次` : ''}
      </span>
      <button className="btn btn-sm" onClick={() => go({ name: 'account' })}>
        查看套餐
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
      fb.toast(ok ? `已开通 ${PLAN_LABEL[a.plan as PlanId]}，感谢支持！` : '正在等待 Mercado Pago 确认付款，几分钟后点「刷新」');
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (!cloud) {
    return (
      <section className="card stack">
        <h2 className="row">
          <ICloud width={20} height={20} /> 账号
        </h2>
        <p className="small">这个网站还没有连接账号服务。管理员请按 README「一键部署」完成初始化。</p>
        <button className="btn btn-primary" style={{ alignSelf: 'flex-start' }} onClick={() => go({ name: 'settings' })}>
          去设置
        </button>
      </section>
    );
  }

  if (!auth.session) {
    return (
      <section className="card stack" aria-labelledby="h-login">
        <h2 id="h-login" className="row">
          <ICloud width={20} height={20} /> 登录账号
        </h2>
        <p className="small">登录后账单在你所有设备间自动同步。新账号免费试用 {TRIAL.days} 天，含 {TRIAL.ai} 次 AI 识别。</p>
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
        {auth.error && <div className="banner bad small">{auth.error}</div>}
        <p className="small">
          {plan === 'trial' && <>免费试用到 <b>{fmtDate(ent?.trialUntil ?? null)}</b>（还剩 {ent?.daysLeft ?? '?'} 天）。</>}
          {plan === 'expired' && <>试用已结束，账单只读。订阅后立即恢复。</>}
          {(plan === 't1' || plan === 't2') && (
            <>
              {PLAN_LABEL[plan]}（{ent?.period === 'year' ? '年付' : '月付'}）有效期至 <b>{fmtDate(ent?.planUntil ?? null)}</b>
              {acc?.autoRenew ? '，到期自动续费。' : acc?.source === 'pix' ? '（PIX 年付，不自动续费）。' : sub === 'cancelled' || acc?.autoRenew === false ? '，已取消自动续费。' : '。'}
              {acc?.source && (!isNative() || acc.source === (platform() === 'ios' ? 'apple' : 'google')) && <span className="xs muted"> 来自{sourceLabel(acc.source)}。</span>}
            </>
          )}
          {plan === 'owner' && <>管理员：全部功能、不限次数。</>}
        </p>
        {usage && usage.limit !== 0 && (
          <div className="stack" style={{ gap: 4 }}>
            <div className="row between small">
              <span>{usage.period === 'trial' ? '试用期 AI 识别' : '本月 AI 识别'}</span>
              <b className="num">{usage.limit < 0 ? `${usage.ai} 次（不限）` : `${usage.ai} / ${usage.limit} 次`}</b>
            </div>
            {usage.limit > 0 && (
              <div className={`meter${pct >= 90 ? ' bad' : ''}`} role="progressbar" aria-valuenow={usage.ai} aria-valuemin={0} aria-valuemax={usage.limit}>
                <div style={{ width: `${pct}%` }} />
              </div>
            )}
            {!!usage.bonus && (
              <div className="row between small">
                <span>AI 加量包剩余</span>
                <b className="num">{usage.bonus} 次</b>
              </div>
            )}
            <span className="xs muted">{usage.period === 'trial' ? '试用期共 ' + TRIAL.ai + ' 次。' : '每月 1 日重置。'}用完后自动用加量包。识别失败不计次数；PDF 直接读文字、本机 OCR 都不占次数。</span>
          </div>
        )}
        <div className="row">
          <button className="btn btn-sm" disabled={!!busy} onClick={() => run('刷新…', refreshAccount)}>
            刷新
          </button>
          {isNative() && acc?.autoRenew && acc.source === (platform() === 'ios' ? 'apple' : 'google') && (
            <button className="btn btn-sm btn-ghost" onClick={() => void manageSubscriptions().catch(() => {})}>
              管理订阅
            </button>
          )}
          {!isNative() && sub === 'authorized' && (acc?.source ?? 'mp') === 'mp' && (
            <button
              className="btn btn-sm btn-ghost"
              disabled={!!busy}
              onClick={async () => {
                const ok = await fb.confirm({ title: '取消自动续费？', body: `已付的期间照常可用，到 ${fmtDate(ent?.planUntil ?? null)} 后变为只读（数据保留）。`, confirmLabel: '取消续费', danger: true });
                if (!ok) return;
                const r = await run('取消中…', async () => {
                  const token = await getToken();
                  if (!token) throw new ApiError(401, '请重新登录');
                  return cancelSubscription(cloud, token);
                });
                if (r) {
                  fb.toast('已取消自动续费');
                  void refreshAccount();
                }
              }}
            >
              取消自动续费
            </button>
          )}
          <button
            className="btn btn-sm btn-ghost"
            onClick={async () => {
              const ok = await fb.confirm({ title: '退出登录？', body: '本机的账单会保留，只是不再同步。重新登录同一个账号即可继续。', confirmLabel: '退出' });
              if (ok) {
                await signOut();
                fb.toast('已退出登录');
              }
            }}
          >
            退出登录
          </button>
        </div>
      </section>

      {plan !== 'owner' && (
        <section className="card stack" aria-labelledby="h-plan">
          <h2 id="h-plan" className="row">
            <IShield width={20} height={20} /> 套餐
          </h2>
          {acc?.subscription?.plan && sub === 'authorized' && acc.subscription.plan !== plan && <p className="xs muted">正在切换到 {PLAN_LABEL[acc.subscription.plan as PlanId] ?? acc.subscription.plan}，付款确认后自动生效并取消原订阅。</p>}
          <Pricing />
        </section>
      )}
      <PackCard />

      <DeviceSection />
      <PushSection />
      <DeleteAccount />
    </>
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
    run('删除中…', async () => {
      if (!cloud) throw new ApiError(0, '没有连接服务');
      const token = await getToken();
      if (!token) throw new ApiError(401, '请重新登录');
      const r = await deleteAccountRemote(cloud, token, text.trim().toLowerCase());
      await signOut();
      await repo.clearAll();
      await reload();
      setOpen(false);
      fb.toast(r.cancelInStore.length ? `账号已删除。别忘了到 ${r.cancelInStore.map((x) => (x === 'apple' ? 'App Store' : 'Google Play')).join('、')} 取消自动续订` : '账号和数据已全部删除');
    });
  return (
    <section className="card stack" aria-labelledby="h-del">
      <details className="more" onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
        <summary id="h-del">删除账号</summary>
        {open && (
          <div className="stack" style={{ marginTop: 8 }}>
            <p className="small">
              将永久删除这个账号、云端的全部账单和识别记录，以及这台设备上的数据，无法恢复。需要的话先到「数据管理」导出备份。
              {storeSub && <b> 在 App Store / Google Play 买的订阅不会自动停止扣费，请到商店的订阅管理里取消。</b>}
              {acc?.source === 'mp' && acc.autoRenew && ' 网页的自动续费会一起取消。'}
            </p>
            <div className="field">
              <label htmlFor="del-confirm">输入你的邮箱 {email} 确认</label>
              <input id="del-confirm" className="input" type="email" autoComplete="off" value={text} onChange={(e) => setText(e.target.value)} placeholder={email} />
            </div>
            <button className="btn btn-danger" style={{ alignSelf: 'flex-start' }} disabled={!!busy || text.trim().toLowerCase() !== email.toLowerCase()} onClick={doDelete}>
              {busy ? <span className="spin" /> : null}
              永久删除账号
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
      if (!token) throw new ApiError(401, '请重新登录');
      await pushSubscribe(cloud, token, sub.toJSON());
      setState('on');
      fb.toast('已开启关屏推送');
    } catch (e) {
      fb.toast(e instanceof ApiError ? e.message : `开启失败：${(e as Error).message}`, { bad: true });
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
      fb.toast('已关闭关屏推送');
    } finally {
      setBusy(false);
    }
  };

  const test = async () => {
    if (!cloud) return;
    setBusy(true);
    try {
      const token = await getToken();
      if (!token) throw new ApiError(401, '请重新登录');
      const r = await pushTest(cloud, token);
      fb.toast(r.sent ? `已发送测试推送（${r.sent} 台设备）` : '没有发出去：请关闭后重新开启推送', { bad: !r.sent });
    } catch (e) {
      fb.toast((e as Error).message, { bad: true });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card stack" aria-labelledby="h-push">
      <h2 id="h-push" className="row">
        <IBell width={20} height={20} /> 关屏推送提醒 {!gate.canPush && <span className="pill neutral">T1 / T2</span>}
      </h2>
      <p className="small">每天圣保罗时间 09:00 左右，把要付和已逾期的账单推送到这台设备，不用打开应用。</p>
      {state === 'unsupported' && <p className="small err">{isIOS() && !standalone() ? 'iPhone 需要先把本应用「添加到主屏幕」，再从主屏幕打开，才能开启推送。' : '这个浏览器不支持网页推送，可以用日历提醒。'}</p>}
      {state === 'denied' && <p className="small err">通知权限被拒绝：请在浏览器的网站设置里改为「允许」后再开启。</p>}
      <div className="row">
        {state === 'off' && (
          <button className="btn btn-primary" disabled={busy} onClick={enable}>
            {busy ? <span className="spin" /> : <IBell />}
            开启推送
          </button>
        )}
        {state === 'on' && (
          <>
            <span className="pill paid">已开启</span>
            <button className="btn btn-sm" disabled={busy} onClick={test}>
              发一条测试
            </button>
            <button className="btn btn-sm btn-ghost" disabled={busy} onClick={disable}>
              关闭
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
          <Logo size={34} /> 账期助手
        </div>
        <h1>
          账期和缴费，
          <br />
          到期前提醒你
        </h1>
        <p>拍照识别单据 · 自动算到期日 · 手机电脑同步</p>
        <HeroArt />
      </div>
      <div className="authpanel">
        <section className="card authcard">
          <LoginForm compact />
        </section>
        <ul className="perks small">
          {['拍照或 PDF 识别订单、boleto、水电税费单', '按商家账期自动算到期日，逾期一目了然', '对账单导入、每月流水、多设备同步', `新账号免费试用 ${TRIAL.days} 天，含 ${TRIAL.ai} 次 AI 识别`].map((t, i) => (
            <li key={t} style={{ animationDelay: `${0.15 + i * 0.07}s` }}>
              <ICheck width={16} height={16} /> {t}
            </li>
          ))}
        </ul>
        <div className="row" style={{ justifyContent: 'center', gap: 4 }}>
          <button className="btn btn-ghost btn-sm" onClick={() => setHelp(true)}>
            <IHelp width={16} height={16} /> 使用教程
          </button>
          <button className="btn btn-ghost btn-sm" onClick={() => setPrices(true)}>
            套餐与价格
          </button>
        </div>
      </div>
      {prices && (
        <Modal title="套餐与价格" onClose={() => setPrices(false)}>
          <div className="stack">
            <p className="small muted">
              新账号免费试用 {TRIAL.days} 天，含 {TRIAL.ai} 次 AI 识别。试用结束后可订阅：
            </p>
            {(['t1', 't2'] as PlanId[]).map((p) => (
              <div key={p} className="card stack" style={{ gap: 4 }}>
                <b>
                  {PLANS[p].name} · {brl(PLANS[p].month)}/月 · {brl(PLANS[p].year)}/年
                </b>
                <span className="small muted">
                  关屏推送、AI 识别 {PLANS[p].ai} 次/月{PLANS[p].export ? '、CSV / Excel 导出' : ''}
                </span>
              </div>
            ))}
            <p className="xs muted">{isNative() ? `通过 ${platform() === 'ios' ? 'App Store' : 'Google Play'} 订阅，可随时取消。` : '网页可用信用卡自动续费或 PIX 一次付清一年；手机 App 里也能订阅。'}没订阅时账单仍可查看和备份。</p>
          </div>
        </Modal>
      )}
      {help && (
        <Modal title="使用教程" onClose={() => setHelp(false)}>
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
          <small>3 天后到期</small>
        </span>
        <b>R$ 368,00</b>
      </div>
      <div className="ha-paid">
        <ICheck width={16} height={16} /> 已付
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
      const ok = await fb.confirm({ title: `关闭${label}解锁？`, body: '关闭后打开应用不再需要验证，账号仍保持登录。', confirmLabel: '关闭' });
      if (ok) {
        await setBiometric(null);
        fb.toast(`已关闭${label}解锁`);
      }
      return;
    }
    setBusy(true);
    try {
      const cfg = await enrollBiometric(user);
      await setBiometric(cfg);
      fb.toast(`已开启：以后打开应用用${label}解锁`);
    } catch (e) {
      fb.toast(e instanceof BiometricError ? e.message : `开启失败：${(e as Error).message}`, { bad: true });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card stack" aria-labelledby="h-device">
      <h2 id="h-device" className="row">
        <ILock width={20} height={20} /> 设备与安全
      </h2>
      <div className="row" style={{ alignItems: 'flex-start', flexWrap: 'nowrap', gap: 10 }}>
        <span className="okdot" aria-hidden="true">
          <ICheck width={14} height={14} />
        </span>
        <span className="small">
          <b>已记住这台设备</b>：登录一次在本机长期有效（至少 {REMEMBER_DAYS} 天），关掉浏览器、重启手机都不用重新登录。手机上建议「添加到主屏幕」，打开更快、也更不容易被系统清理。
        </span>
      </div>
      {avail === false && <p className="xs muted">这台设备或浏览器不支持{label}解锁（需要面容 / 指纹硬件和 https 网址）。</p>}
      {avail && (
        <>
          <label className="switchrow">
            <span className="grow stack" style={{ gap: 2 }}>
              <b className="small row" style={{ gap: 6 }}>
                <IFace width={18} height={18} /> 打开应用时用{label}解锁
              </b>
              <span className="xs muted">别人拿到你的手机也看不到账单。离开应用超过 5 分钟回来会重新验证。生物信息只在本机芯片里，不会上传。</span>
            </span>
            <input type="checkbox" role="switch" className="switch" checked={on} disabled={busy} onChange={toggle} aria-label={`打开应用时用${label}解锁`} />
          </label>
          {on && (
            <button className="btn btn-sm btn-ghost" style={{ alignSelf: 'flex-start' }} onClick={lockNow}>
              <ILock width={16} height={16} /> 立即锁定
            </button>
          )}
        </>
      )}
    </section>
  );
}

