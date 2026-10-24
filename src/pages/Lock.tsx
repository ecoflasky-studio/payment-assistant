import { useEffect, useRef, useState } from 'react';
import { useStore } from '../store';
import { biometricLabel, verifyBiometric, BiometricError } from '../cloud/biometric';
import { signInPassword, AuthError } from '../cloud/auth';
import { IFace, ILock } from '../ui/icons';

/** 打开应用时的面容 ID / 指纹锁屏 */
export function LockScreen() {
  const { lock, unlockApp, auth, cloud, replaceSession, signOut } = useStore();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [usePw, setUsePw] = useState(false);
  const [pw, setPw] = useState('');
  const [ok, setOk] = useState(false);
  const tried = useRef(false);
  const label = biometricLabel();
  const email = auth.session?.user.email ?? '';

  const tryBio = async () => {
    if (!lock.cfg || busy) return;
    setBusy(true);
    setErr(null);
    try {
      await verifyBiometric(lock.cfg);
      setOk(true);
      setTimeout(unlockApp, 380);
    } catch (e) {
      setErr(e instanceof BiometricError ? e.message : '验证失败，请再试一次');
    } finally {
      setBusy(false);
    }
  };

  // 打开时自动弹一次（iPhone 有时要求先点一下，失败了就显示按钮）
  useEffect(() => {
    if (tried.current) return;
    tried.current = true;
    void tryBio();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const tryPw = async () => {
    if (!cloud || !pw) return;
    setBusy(true);
    setErr(null);
    try {
      await replaceSession(await signInPassword(cloud, email, pw));
    } catch (e) {
      setErr(e instanceof AuthError ? e.message : '验证失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="lockscreen" role="dialog" aria-modal="true" aria-label="应用已锁定">
      <div className="lock-card">
        <div className={`lock-face${busy ? ' scanning' : ''}${ok ? ' ok' : ''}`} aria-hidden="true">
          <IFace width={56} height={56} />
        </div>
        <h1>账期助手已锁定</h1>
        <p className="small muted">{email}</p>
        {err && <p className="small err" role="alert">{err}</p>}
        {!usePw ? (
          <>
            <button className="btn btn-primary btn-lg btn-block" onClick={tryBio} disabled={busy}>
              {busy ? <span className="spin" /> : <IFace />}
              用{label}解锁
            </button>
            <button className="btn btn-ghost btn-sm" onClick={() => setUsePw(true)}>
              <ILock width={16} height={16} /> 用密码解锁
            </button>
          </>
        ) : (
          <>
            <div className="field" style={{ width: '100%' }}>
              <label htmlFor="lock-pw">账号密码</label>
              <input id="lock-pw" className="input" type="password" autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && tryPw()} autoFocus />
            </div>
            <button className="btn btn-primary btn-block" onClick={tryPw} disabled={busy || !pw}>
              {busy ? <span className="spin" /> : null}
              解锁
            </button>
            <button className="btn btn-ghost btn-sm" onClick={() => setUsePw(false)}>
              <IFace width={16} height={16} /> 改用{label}
            </button>
          </>
        )}
        <button className="linkbtn xs muted" onClick={() => void signOut()}>
          不是你？退出登录
        </button>
      </div>
    </div>
  );
}
