import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
// 字体打包进应用（App 离线可用，不向 Google 请求）：Nunito 圆润数字与拉丁字母；中文用系统字体
import '@fontsource/nunito/latin-600.css';
import '@fontsource/nunito/latin-700.css';
import '@fontsource/nunito/latin-800.css';
import '@fontsource/nunito/latin-900.css';
import './styles.css';
import { applyTheme } from './theme';
import { isNative } from './native/platform';

applyTheme();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// PWA：仅在独立部署（https 或 localhost）时注册 Service Worker
// 原生 App：资源已打包在安装包里，不用 Service Worker
if (!__SINGLE__ && !isNative() && 'serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
}
