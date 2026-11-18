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
import { tr } from './i18n';
import { isNative } from './native/platform';

applyTheme();
// 手机键盘弹起时（输入框获得焦点）隐藏浮动底栏，免得挡住下拉列表和输入框
if (typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches) {
  const isField = (t: EventTarget | null) => t instanceof HTMLElement && (t.matches('input:not([type=checkbox]):not([type=radio]):not([type=file]):not([type=range]), textarea, select') || t.isContentEditable);
  document.addEventListener('focusin', (e) => isField(e.target) && document.body.classList.add('kb-open'));
  document.addEventListener('focusout', () => setTimeout(() => !isField(document.activeElement) && document.body.classList.remove('kb-open'), 120));
}
document.title = tr('账期助手');

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
