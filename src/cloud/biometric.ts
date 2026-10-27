/**
 * 面容 ID / 指纹解锁（本机应用锁）
 *
 * 用浏览器的 WebAuthn「平台验证器」（iPhone 面容 ID / 触控 ID、安卓指纹或人脸、Windows Hello、Mac 触控 ID）。
 * 这是「打开应用时验证本人」的锁屏，不替代账号登录：账号登录一次在本机长期有效，
 * 之后每次打开只需刷脸/指纹。凭证只存在这台设备的安全芯片里，不上传任何生物信息。
 */

import { isNative } from '../native/platform';
import { nativeBiometricAvailable, nativeAuthenticate } from '../native/biometric';

export interface BiometricConfig {
  /** 凭证 ID（base64url） */
  credId: string;
  userId: string;
  enabledAt: string;
}

export const META_BIOMETRIC = 'lock.biometric';
/** 离开应用超过这么久，回来要重新解锁 */
export const RELOCK_MS = 5 * 60_000;

const b64u = (buf: ArrayBuffer | Uint8Array) => {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const unb64u = (s: string) => {
  const p = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(p + '='.repeat((4 - (p.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};
const random = (n: number) => crypto.getRandomValues(new Uint8Array(n));

/** 这台设备能不能用面容 / 指纹（需要 https 和平台验证器） */
export async function biometricAvailable(): Promise<boolean> {
  if (isNative()) return nativeBiometricAvailable();
  try {
    if (typeof window === 'undefined' || !window.isSecureContext || !('PublicKeyCredential' in window)) return false;
    return await (window.PublicKeyCredential as any).isUserVerifyingPlatformAuthenticatorAvailable();
  } catch {
    return false;
  }
}

/** 按设备给出叫法 */
export function biometricLabel(ua = typeof navigator !== 'undefined' ? navigator.userAgent : ''): string {
  if (/iPhone|iPad|iPod/.test(ua)) return '面容 ID / 触控 ID';
  if (/Android/.test(ua)) return '指纹或面部解锁';
  if (/Macintosh/.test(ua)) return '触控 ID';
  if (/Windows/.test(ua)) return 'Windows Hello';
  return '设备验证';
}

export class BiometricError extends Error {
  constructor(public code: 'cancelled' | 'unsupported' | 'failed', message: string) {
    super(message);
  }
}

function explain(e: unknown): BiometricError {
  const name = (e as any)?.name;
  if (name === 'NotAllowedError' || name === 'AbortError') return new BiometricError('cancelled', '已取消或超时，请再试一次');
  if (name === 'NotSupportedError' || name === 'SecurityError') return new BiometricError('unsupported', '这个浏览器或网址不支持面容 / 指纹解锁');
  return new BiometricError('failed', `验证失败：${(e as Error)?.message ?? e}`);
}

/** 开启：在这台设备上创建一个只能用本人生物特征解锁的凭证 */
export async function enrollBiometric(user: { id: string; email: string }): Promise<BiometricConfig> {
  if (isNative()) {
    try {
      await nativeAuthenticate('开启后，打开账期助手时用它验证本人');
    } catch (e: any) {
      throw new BiometricError(e?.cancelled ? 'cancelled' : 'failed', e?.cancelled ? '已取消' : `开启失败：${e?.message ?? e}`);
    }
    return { credId: 'native', userId: user.id, enabledAt: new Date().toISOString() };
  }
  let cred: PublicKeyCredential | null;
  try {
    cred = (await navigator.credentials.create({
      publicKey: {
        challenge: random(32),
        rp: { name: '账期助手' },
        user: { id: new TextEncoder().encode(user.id.slice(0, 64)), name: user.email || '账期助手用户', displayName: user.email || '账期助手用户' },
        pubKeyCredParams: [
          { type: 'public-key', alg: -7 },
          { type: 'public-key', alg: -257 },
        ],
        authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'discouraged' },
        timeout: 60_000,
        attestation: 'none',
      },
    })) as PublicKeyCredential | null;
  } catch (e) {
    throw explain(e);
  }
  if (!cred) throw new BiometricError('failed', '没有创建成功，请再试一次');
  return { credId: b64u(cred.rawId), userId: user.id, enabledAt: new Date().toISOString() };
}

/** 解锁：要求本人验证（面容 / 指纹 / 设备密码） */
export async function verifyBiometric(cfg: BiometricConfig): Promise<true> {
  if (cfg.credId === 'native' || isNative()) {
    try {
      await nativeAuthenticate('解锁账期助手');
      return true;
    } catch (e: any) {
      throw new BiometricError(e?.cancelled ? 'cancelled' : 'failed', e?.cancelled ? '已取消，请再试一次' : '验证没有通过');
    }
  }
  try {
    const got = (await navigator.credentials.get({
      publicKey: {
        challenge: random(32),
        allowCredentials: [{ type: 'public-key', id: unb64u(cfg.credId) as BufferSource, transports: ['internal'] }],
        userVerification: 'required',
        timeout: 60_000,
      },
    })) as PublicKeyCredential | null;
    if (!got) throw new BiometricError('failed', '验证没有通过');
    const flags = new Uint8Array((got.response as AuthenticatorAssertionResponse).authenticatorData)[32];
    // UV 位：确实做了本人验证（不是只按了一下）
    if (!(flags & 0x04)) throw new BiometricError('failed', '没有完成本人验证');
    return true;
  } catch (e) {
    if (e instanceof BiometricError) throw e;
    throw explain(e);
  }
}
