/**
 * 原生 App（Capacitor：iOS / Android）与网页的差异都在 src/native/ 里处理。
 * 网页版不会加载原生插件（都是动态 import），体积几乎不变。
 */
import { Capacitor } from '@capacitor/core';

export type Platform = 'ios' | 'android' | 'web';

export const isNative = (): boolean => {
  try {
    return Capacitor.isNativePlatform();
  } catch {
    return false;
  }
};

export const platform = (): Platform => {
  try {
    const p = Capacitor.getPlatform();
    return p === 'ios' || p === 'android' ? p : 'web';
  } catch {
    return 'web';
  }
};

/** 商店名称（付款说明里用） */
export const storeName = () => (platform() === 'ios' ? 'App Store' : platform() === 'android' ? 'Google Play' : 'Mercado Pago');

/** 用系统浏览器打开外部网址（原生 App 里 window.open 不可靠） */
export async function openExternal(url: string) {
  if (isNative()) {
    const { Browser } = await import('@capacitor/browser');
    await Browser.open({ url });
  } else window.open(url, '_blank', 'noopener');
}

/** 原生 App 启动：状态栏颜色、启动图、安卓返回键 */
export async function initNative(onBack: () => boolean) {
  if (!isNative()) return;
  const [{ StatusBar, Style }, { SplashScreen }, { App }] = await Promise.all([import('@capacitor/status-bar'), import('@capacitor/splash-screen'), import('@capacitor/app')]);
  const { onThemeApplied } = await import('../theme');
  onThemeApplied((dark) => {
    void StatusBar.setStyle({ style: dark ? Style.Dark : Style.Light }).catch(() => {});
    if (platform() === 'android') void StatusBar.setBackgroundColor({ color: dark ? '#140f2b' : '#f1ecff' }).catch(() => {});
  });
  await SplashScreen.hide().catch(() => {});
  App.addListener('backButton', () => {
    if (!onBack()) App.exitApp();
  });
}

/** 轻微震动（标记已付等）；网页上用 navigator.vibrate */
export async function tap() {
  if (isNative()) {
    const { Haptics, ImpactStyle } = await import('@capacitor/haptics');
    await Haptics.impact({ style: ImpactStyle.Light }).catch(() => {});
  } else {
    try {
      navigator.vibrate?.(15);
    } catch {}
  }
}
