/** 原生 App 的面容 ID / 指纹（系统生物识别；WebAuthn 在 App 内的网页里不可用） */
import { isNative } from './platform';

export async function nativeBiometricAvailable(): Promise<boolean> {
  if (!isNative()) return false;
  try {
    const { BiometricAuth } = await import('@aparajita/capacitor-biometric-auth');
    const r = await BiometricAuth.checkBiometry();
    return !!(r.isAvailable || r.deviceIsSecure);
  } catch {
    return false;
  }
}

export async function nativeAuthenticate(reason: string): Promise<void> {
  const { BiometricAuth, BiometryError, BiometryErrorType } = await import('@aparajita/capacitor-biometric-auth');
  try {
    await BiometricAuth.authenticate({ reason, cancelTitle: '取消', allowDeviceCredential: true, iosFallbackTitle: '使用密码', androidTitle: '账期助手', androidSubtitle: reason });
  } catch (e) {
    if (e instanceof BiometryError && (e.code === BiometryErrorType.userCancel || e.code === BiometryErrorType.appCancel || e.code === BiometryErrorType.systemCancel)) {
      const err = new Error('已取消') as Error & { cancelled?: boolean };
      err.cancelled = true;
      throw err;
    }
    throw e;
  }
}
