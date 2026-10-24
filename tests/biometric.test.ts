import { describe, it, expect, vi, afterEach } from 'vitest';
import { enrollBiometric, verifyBiometric, biometricLabel, biometricAvailable, BiometricError } from '../src/cloud/biometric';
import { placeBubble, shouldAutoStart, tourDone, markTourDone, TOUR_STEPS, TOUR_DONE } from '../src/ui/Tour';

const authData = (flags: number) => {
  const a = new Uint8Array(37);
  a[32] = flags;
  return a.buffer;
};

afterEach(() => vi.unstubAllGlobals());

describe('面容 / 指纹解锁（本机应用锁）', () => {
  it('按设备给出叫法', () => {
    expect(biometricLabel('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)')).toBe('面容 ID / 触控 ID');
    expect(biometricLabel('Mozilla/5.0 (Linux; Android 14; Pixel 8)')).toBe('指纹或面部解锁');
    expect(biometricLabel('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe('Windows Hello');
    expect(biometricLabel('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)')).toBe('触控 ID');
    expect(biometricLabel('curl/8')).toBe('设备验证');
  });

  it('非 https 或不支持时报告不可用，不抛错', async () => {
    vi.stubGlobal('window', { isSecureContext: false });
    expect(await biometricAvailable()).toBe(false);
    vi.stubGlobal('window', { isSecureContext: true, PublicKeyCredential: { isUserVerifyingPlatformAuthenticatorAvailable: async () => true } });
    expect(await biometricAvailable()).toBe(true);
  });

  it('开启：要求平台验证器 + 本人验证，只保存凭证 ID', async () => {
    let opts: any;
    vi.stubGlobal('navigator', { credentials: { create: async (o: any) => ((opts = o.publicKey), { rawId: new Uint8Array([1, 2, 250, 255]).buffer }) } });
    const cfg = await enrollBiometric({ id: 'user-1', email: 'a@b.co' });
    expect(cfg.credId).toBe('AQL6_w');
    expect(cfg.userId).toBe('user-1');
    expect(opts.authenticatorSelection).toMatchObject({ authenticatorAttachment: 'platform', userVerification: 'required' });
    expect(opts.attestation).toBe('none');
  });

  it('解锁：必须带 UV 位；只按一下（UP）不算', async () => {
    const cfg = { credId: 'AQL6_w', userId: 'u', enabledAt: '' };
    let allow: any;
    vi.stubGlobal('navigator', { credentials: { get: async (o: any) => ((allow = o.publicKey.allowCredentials), { response: { authenticatorData: authData(0x05) } }) } });
    await expect(verifyBiometric(cfg)).resolves.toBe(true);
    expect([...allow[0].id]).toEqual([1, 2, 250, 255]);
    vi.stubGlobal('navigator', { credentials: { get: async () => ({ response: { authenticatorData: authData(0x01) } }) } });
    await expect(verifyBiometric(cfg)).rejects.toMatchObject({ code: 'failed' });
  });

  it('用户取消 → cancelled；浏览器不支持 → unsupported', async () => {
    const cfg = { credId: 'AQ', userId: 'u', enabledAt: '' };
    const err = (name: string) => Object.assign(new Error(name), { name });
    vi.stubGlobal('navigator', { credentials: { get: async () => { throw err('NotAllowedError'); } } });
    await expect(verifyBiometric(cfg)).rejects.toMatchObject({ code: 'cancelled' });
    vi.stubGlobal('navigator', { credentials: { create: async () => { throw err('NotSupportedError'); } } });
    const e = await enrollBiometric({ id: 'u', email: '' }).catch((x) => x);
    expect(e).toBeInstanceOf(BiometricError);
    expect(e.code).toBe('unsupported');
  });
});

describe('新手导览', () => {
  it('只在公开部署、已登录、未锁定、首页、没看过时自动播放', () => {
    const base = { saas: true, signedIn: true, locked: false, route: 'home', done: false };
    expect(shouldAutoStart(base)).toBe(true);
    expect(shouldAutoStart({ ...base, done: true })).toBe(false);
    expect(shouldAutoStart({ ...base, locked: true })).toBe(false);
    expect(shouldAutoStart({ ...base, route: 'bills' })).toBe(false);
    expect(shouldAutoStart({ ...base, signedIn: false })).toBe(false);
    expect(shouldAutoStart({ ...base, saas: false })).toBe(false);
  });

  it('看过一次后记住；存储不可用时不打扰', () => {
    const m = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) });
    expect(tourDone()).toBe(false);
    markTourDone();
    expect(m.get(TOUR_DONE)).toBe('1');
    expect(tourDone()).toBe(true);
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('denied'); } });
    expect(tourDone()).toBe(true);
  });

  it('步骤：首尾是说明卡，中间都指向界面元素', () => {
    expect(TOUR_STEPS[0].target).toBeUndefined();
    expect(TOUR_STEPS.at(-1)!.target).toBeUndefined();
    expect(TOUR_STEPS.slice(1, -1).map((s) => s.target)).toEqual(['add', 'capture', 'bills', 'flow', 'settings']);
  });

  it('气泡默认放目标下方，底部放不下放上方，左右不出屏幕', () => {
    expect(placeBubble(null, 400, 800, 320, 150)).toEqual({ top: 325, left: 40, side: 'center' });
    const below = placeBubble({ top: 100, left: 10, width: 60, height: 40 }, 400, 800, 320, 150);
    expect(below).toEqual({ top: 152, left: 12, side: 'below' });
    // 底栏按钮：放上方
    const above = placeBubble({ top: 740, left: 340, width: 56, height: 56 }, 400, 800, 320, 150);
    expect(above.side).toBe('above');
    expect(above.top).toBe(740 - 12 - 150);
    expect(above.left).toBe(400 - 320 - 12);
    // 窄屏：气泡宽度收窄到屏幕内
    const narrow = placeBubble({ top: 100, left: 0, width: 50, height: 30 }, 300, 800, 320, 150);
    expect(narrow.left).toBe(12);
  });
});
