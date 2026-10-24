/**
 * 登录会话保持（「记住这台设备」）：
 *  - Supabase 的 refresh token 默认永不过期，但每个只能用一次（10 秒宽限）。
 *    同一台设备开了两个标签页时，如果都拿旧的 refresh token 去续期，会被当成令牌被盗，整个会话作废 → 被迫重新登录。
 *  - 所以续期时：① 用浏览器锁保证同一时间只有一个标签页在续期；② 续期前先读数据库里最新的会话（别的标签页可能刚续过）；
 *    ③ 续期失败时再读一次，确认不是别的标签页抢先续了，才判定真的过期。
 *  - 网络问题不会退出登录，继续用旧会话，下次再续。
 */
import { needsRefresh, AuthError, type Session } from './auth';

export interface SessionStore {
  load(): Promise<Session | null>;
  save(s: Session | null): Promise<void>;
}

export type RefreshFn = (s: Session) => Promise<Session>;

/** 同一时间只让一个标签页续期（不支持 Web Locks 的浏览器直接执行） */
export async function withAuthLock<T>(fn: () => Promise<T>): Promise<T> {
  const locks = typeof navigator !== 'undefined' ? (navigator as any).locks : undefined;
  if (locks?.request) return locks.request('zq-auth-refresh', fn);
  return fn();
}

export type FreshResult = { session: Session; changed: boolean } | { session: null; expired: boolean };

/**
 * 拿到一个可用的会话：
 *  - 当前会话还有效 → 直接用
 *  - 别的标签页已经续过 → 用存储里的新会话
 *  - 否则续期并保存
 *  - 续期失败：令牌确实失效 → { session: null, expired: true }；网络等问题 → 继续用旧会话
 */
export async function ensureFresh(current: Session, store: SessionStore, refresh: RefreshFn, lock: typeof withAuthLock = withAuthLock, now = () => Date.now()): Promise<FreshResult> {
  if (!needsRefresh(current, now())) return { session: current, changed: false };
  return lock(async () => {
    const latest = await store.load();
    // 别的标签页已经退出登录
    if (!latest) return { session: null, expired: false };
    if (latest.user.id !== current.user.id) return { session: latest, changed: true };
    if (latest.refreshToken !== current.refreshToken && !needsRefresh(latest, now())) return { session: latest, changed: true };
    const base = latest;
    try {
      const next = await refresh(base);
      await store.save(next);
      return { session: next, changed: true };
    } catch (e) {
      if (e instanceof AuthError && e.code === 'session_expired') {
        // 再确认一次：也许别的标签页在这期间续期成功了
        const again = await store.load();
        if (again && again.refreshToken !== base.refreshToken) return { session: again, changed: true };
        return { session: null, expired: true };
      }
      // 网络问题：先用旧会话（access token 过期的话请求会失败，但不会退出登录）
      return { session: base, changed: base !== current };
    }
  });
}

/** 申请持久存储，减少浏览器清理本地数据（登录状态、账单）的可能 */
export async function requestPersistentStorage(): Promise<boolean> {
  try {
    const st = typeof navigator !== 'undefined' ? navigator.storage : undefined;
    if (!st?.persist) return false;
    if (await st.persisted?.()) return true;
    return await st.persist();
  } catch {
    return false;
  }
}

/** 记住设备的承诺时长（天）：Supabase 默认会话不过期，这里是给用户看的最低保证 */
export const REMEMBER_DAYS = 180;
