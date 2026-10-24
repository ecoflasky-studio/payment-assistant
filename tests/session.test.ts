import { describe, it, expect } from 'vitest';
import { ensureFresh, type SessionStore } from '../src/cloud/session';
import { AuthError, type Session } from '../src/cloud/auth';

const NOW = 1_800_000_000_000;
const S = (rt: string, expiresIn: number, id = 'u1'): Session => ({ url: 'https://p.supabase.co', key: 'k', accessToken: `at-${rt}`, refreshToken: rt, expiresAt: NOW + expiresIn, user: { id, email: 'a@b.co' } });
const mem = (init: Session | null) => {
  let v = init;
  const s: SessionStore & { v: () => Session | null } = { load: async () => v, save: async (n) => void (v = n), v: () => v };
  return s;
};
const noLock = async <T,>(fn: () => Promise<T>) => fn();
const now = () => NOW;

describe('记住设备：续期不会把自己踢下线', () => {
  it('令牌还有效：不续期', async () => {
    const st = mem(S('r1', 3600_000));
    let calls = 0;
    const r = await ensureFresh(S('r1', 3600_000), st, async (x) => (calls++, x), noLock, now);
    expect(r).toMatchObject({ changed: false });
    expect(calls).toBe(0);
  });
  it('快过期：续期并保存新令牌', async () => {
    const st = mem(S('r1', 10_000));
    const r = await ensureFresh(S('r1', 10_000), st, async () => S('r2', 3600_000), noLock, now);
    expect(r.session?.refreshToken).toBe('r2');
    expect(st.v()?.refreshToken).toBe('r2');
  });
  it('另一个标签页已经续过：直接用新令牌，绝不拿旧 refresh token 再续（否则会触发令牌复用、整个会话作废）', async () => {
    const st = mem(S('r2', 3600_000));
    const used: string[] = [];
    const r = await ensureFresh(S('r1', 10_000), st, async (x) => (used.push(x.refreshToken), S('r3', 3600_000)), noLock, now);
    expect(used).toEqual([]);
    expect(r.session?.refreshToken).toBe('r2');
  });
  it('存储里的令牌也快过期：用存储里最新的那个去续，而不是内存里的旧令牌', async () => {
    const st = mem(S('r2', 5_000));
    const used: string[] = [];
    await ensureFresh(S('r1', 5_000), st, async (x) => (used.push(x.refreshToken), S('r3', 3600_000)), noLock, now);
    expect(used).toEqual(['r2']);
  });
  it('网络失败：不退出登录，继续用旧会话', async () => {
    const st = mem(S('r1', 5_000));
    const r = await ensureFresh(S('r1', 5_000), st, async () => {
      throw new AuthError('network', 'x');
    }, noLock, now);
    expect(r.session?.refreshToken).toBe('r1');
  });
  it('令牌被服务器作废：返回已过期；但如果期间别的标签页续期成功，就用它', async () => {
    const st = mem(S('r1', 5_000));
    const r = await ensureFresh(S('r1', 5_000), st, async () => {
      throw new AuthError('session_expired', 'x');
    }, noLock, now);
    expect(r).toEqual({ session: null, expired: true });
    const st2 = mem(S('r1', 5_000));
    const r2 = await ensureFresh(S('r1', 5_000), st2, async () => {
      await st2.save(S('r9', 3600_000));
      throw new AuthError('session_expired', 'x');
    }, noLock, now);
    expect(r2.session?.refreshToken).toBe('r9');
  });
  it('别的标签页已退出登录：这里也退出（不是过期）', async () => {
    const r = await ensureFresh(S('r1', 5_000), mem(null), async (x) => x, noLock, now);
    expect(r).toEqual({ session: null, expired: false });
  });
  it('两个标签页同时续期：加锁后只续一次', async () => {
    const st = mem(S('r1', 5_000));
    let calls = 0;
    let chain = Promise.resolve();
    const lock = <T,>(fn: () => Promise<T>) => {
      const p = chain.then(fn);
      chain = p.then(() => undefined, () => undefined);
      return p;
    };
    const refresh = async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 5));
      return S(`r${calls + 1}`, 3600_000);
    };
    const [a, b] = await Promise.all([ensureFresh(S('r1', 5_000), st, refresh, lock, now), ensureFresh(S('r1', 5_000), st, refresh, lock, now)]);
    expect(calls).toBe(1);
    expect(a.session?.refreshToken).toBe('r2');
    expect(b.session?.refreshToken).toBe('r2');
  });
});
