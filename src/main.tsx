/** 入口：先确定语言、加载词典，再加载应用（界面文字在模块加载时就要用到语言） */
import { initI18n } from './i18n-load';
import { applyTheme } from './theme';

// 主题先上，避免加载词典时闪白
applyTheme();
void initI18n().then(() => import('./boot'));
