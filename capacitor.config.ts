import type { CapacitorConfig } from '@capacitor/cli';

/**
 * 原生 App 配置（iOS / Android）。
 * appId 是商店里的唯一标识（Bundle ID / 包名），上架后不能改：
 *   先在 App Store Connect 和 Google Play Console 用同一个 ID 建 App，再改这里（或设环境变量 APP_ID）。
 */
const config: CapacitorConfig = {
  appId: process.env.APP_ID || 'com.ecoflasky.zhangqi',
  appName: '账期助手',
  webDir: 'dist-app',
  backgroundColor: '#f1ecff',
  ios: {
    contentInset: 'never',
    scheme: 'ZhangQi',
  },
  android: {
    allowMixedContent: false,
  },
  plugins: {
    SplashScreen: { launchAutoHide: false, backgroundColor: '#f1ecff', showSpinner: false },
    LocalNotifications: { smallIcon: 'ic_stat_notify', iconColor: '#5b3df5' },
    StatusBar: { overlaysWebView: false, style: 'LIGHT', backgroundColor: '#f1ecff' },
  },
};

export default config;
