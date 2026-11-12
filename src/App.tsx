import { tr, tx } from './i18n';
import { Component, Suspense, useEffect, useRef, useState, type ReactNode } from 'react';
import { StoreProvider, useStore, type Route } from './store';
import { FeedbackProvider } from './ui/feedback';
import { Dashboard, PickImageButton } from './pages/Dashboard';
import { Bills } from './pages/Bills';
import { AccountPage, PaywallModal, ReadOnlyPage, Welcome } from './pages/Account';
import { LockScreen } from './pages/Lock';
import { Logo } from './ui/Logo';
import { HelpPage } from './pages/Help';
import { lazyPage, prefetch } from './lazy';

const loadEditor = () => import('./pages/Editor');
const loadCapture = () => import('./pages/Capture');
const loadInsights = () => import('./pages/Insights');
const EditorPage = lazyPage(loadEditor, 'EditorPage');
const CapturePage = lazyPage(loadCapture, 'CapturePage');
const Masters = lazyPage(() => import('./pages/Masters'), 'Masters');
const loadSettings = () => import('./pages/Settings');
const SettingsPage = lazyPage(loadSettings, 'SettingsPage');
const RemindSettingsPage = lazyPage(loadSettings, 'RemindSettingsPage');
const AiSettingsPage = lazyPage(loadSettings, 'AiSettingsPage');
const DevSettingsPage = lazyPage(loadSettings, 'DevSettingsPage');
const DataPage = lazyPage(() => import('./pages/DataPage'), 'DataPage');
const FlowPage = lazyPage(() => import('./pages/Flow'), 'FlowPage');
const ReportPage = lazyPage(loadInsights, 'ReportPage');
const CashflowPage = lazyPage(loadInsights, 'CashflowPage');
const ReconcilePage = lazyPage(loadInsights, 'ReconcilePage');
const SearchSheet = lazyPage(loadInsights, 'SearchSheet');
prefetch([loadEditor, loadCapture, loadInsights]);
import { Tour, shouldAutoStart, tourDone } from './ui/Tour';
import { initNative, platform } from './native/platform';
import { configureErrorReports, installGlobalHandlers, reportError } from './lib/errorReport';
import { sendErrorReport } from './cloud/api';
import { onReminderTap } from './native/reminders';
import { useReminders } from './reminders';
import { IHome, IList, IPlus, IStore, ISettings, ICamera, IEdit, IImage, IBolt, ICloud } from './ui/icons';
import { syncLabel } from './pages/SyncSettings';
import { useTheme } from './theme';
import { ISun, IMoon, IChart, ISearch } from './ui/icons';
import { Modal } from './ui/feedback';

const TITLES: Record<Route['name'], string> = {
  home: tr('账期助手'),
  bills: tr('账单'),
  new: tr('新增账单'),
  edit: tr('编辑账单'),
  copy: tr('复制账单'),
  capture: tr('票据识别'),
  review: tr('核对识别结果'),
  masters: tr('固定资料'),
  settings: tr('设置'),
  'set-remind': tr('提醒与预算'),
  'set-ai': tr('AI 识别与隐私'),
  'set-dev': tr('部署与识别服务'),
  data: tr('数据管理'),
  account: tr('账号与套餐'),
  help: tr('使用教程'),
  report: tr('报表'),
  cashflow: tr('报表'),
  reconcile: tr('报表'),
  flow: tr('报表'),
};

function Shell() {
  const { ready, fatal, route, go, back, storageError, sync, syncNow, gate, auth, requireFeature, lock, cloud, settings } = useStore();
  const routeRef = useRef(route.name);
  routeRef.current = route.name;
  useEffect(() => {
    installGlobalHandlers();
    configureErrorReports({ send: cloud && !__SINGLE__ ? (r) => sendErrorReport(cloud, r) : null, enabled: settings.errorReports !== false, where: () => routeRef.current, platform: platform() });
  }, [cloud, settings.errorReports]);
  const openAdd = () => requireFeature('edit') && setAddOpen(true);
  const rem = useReminders();
  const [, setTheme, theme] = useTheme();
  const [addOpen, setAddOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [online, setOnline] = useState(typeof navigator === 'undefined' ? true : navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);

  // 原生 App：状态栏、启动图、安卓返回键、点提醒通知打开账单
  useEffect(() => {
    void initNative(() => {
      if (document.querySelector('.modal-bg')) {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
        return true;
      }
      if (routeRef.current === 'home') return false;
      back();
      return true;
    });
    void onReminderTap((h) => (location.hash = h));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // 键盘快捷键（电脑上）：n 新增，/ 搜索，g 回首页，l 账单，f 流水
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(input|textarea|select)$/i.test(t.tagName))) return;
      if (document.querySelector('.modal-bg')) return;
      const k = e.key.toLowerCase();
      if (k === 'n') {
        e.preventDefault();
        openAdd();
      } else if (e.key === '/') {
        e.preventDefault();
        setSearchOpen(true);
      } else if (k === 'g') go({ name: 'home' });
      else if (k === 'l') go({ name: 'bills' });
      else if (k === 'f') go({ name: 'flow' });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [go, route.name]);

  // 公开部署：未登录先看到介绍与注册登录
  if (ready && !fatal && gate.saas && !auth.session) return <Welcome />;
  if (ready && !fatal && gate.saas && auth.session && lock.locked) return <LockScreen />;

  if (fatal) {
    return (
      <div className="content">
        <div className="card stack" role="alert">
          <h2>{tr('无法打开本地数据')}</h2>
          <p>{tx(fatal.message)}</p>
          <p className="muted">{fatal.hint}</p>
          <p className="small muted">{tr('你的数据没有被删除。解决后刷新页面即可。')}</p>
          <button className="btn btn-primary" onClick={() => location.reload()}>
            {tr('刷新')}
          </button>
        </div>
      </div>
    );
  }

  const top = ['home', 'bills', 'flow', 'settings', 'report', 'cashflow', 'reconcile'].includes(route.name);
  const nav: { r: Route; label: string; icon: ReactNode; badge?: number }[] = [
    { r: { name: 'home' }, label: tr('首页'), icon: <IHome /> },
    { r: { name: 'bills' }, label: tr('账单'), icon: <IList />, badge: rem.overdue || undefined },
    { r: { name: 'flow' }, label: tr('报表'), icon: <IChart /> },
    { r: { name: 'settings' }, label: tr('设置'), icon: <ISettings /> },
  ];
  // 电脑侧栏多一个「资料」；手机上从「设置」进入
  const sideNav: typeof nav = [...nav.slice(0, 3), { r: { name: 'masters' }, label: tr('资料'), icon: <IStore /> }, nav[3]];
  const isCur = (r: Route) => r.name === route.name || (r.name === 'flow' && ['report', 'cashflow', 'reconcile'].includes(route.name)) || (r.name === 'settings' && ['data', 'account', 'help', 'set-remind', 'set-ai', 'set-dev'].includes(route.name));
  const isCurTab = (r: Route) => isCur(r) || (r.name === 'settings' && route.name === 'masters');

  return (
    <div className="shell">
      <nav className="side" aria-label={tr('主导航')}>
        <div className="brandmark">
          <Logo /> {tr('账期助手')}
        </div>
        <button className="btn btn-primary newbtn" data-tour="add" onClick={openAdd}>
          <IPlus />
          {tr('新增账单')}
        </button>
        {sideNav.map((n) => (
          <button key={n.r.name} className="navbtn" data-tour={n.r.name} aria-current={isCur(n.r) ? 'page' : undefined} onClick={() => go(n.r)}>
            {n.icon}
            {n.label}
            {n.badge ? <span className="badge">{n.badge}</span> : null}
          </button>
        ))}
        <button className="xs" style={{ marginTop: 'auto', color: 'var(--bar-muted)', padding: '6px 10px', background: 'none', border: 0, textAlign: 'left', cursor: 'pointer', font: 'inherit' }} onClick={() => go({ name: 'settings' })}>
          {sync.config ? syncLabel(sync) : tr('仅保存在本设备')}
        </button>
      </nav>
      <div className="main">
        <header className="topbar">
          {!top && (
            <button className="back" aria-label={tr('返回')} onClick={back}>
              ‹
            </button>
          )}
          <h1>{TITLES[route.name]}</h1>
          <button className="syncdot" onClick={() => setSearchOpen(true)} aria-label={tr('搜索全部账单（快捷键 /）')} title={tr('搜索（/）')}>
            <ISearch />
          </button>
          <button className="syncdot" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} aria-label={theme === 'dark' ? tr('切换到光明模式') : tr('切换到深色模式')} title={theme === 'dark' ? tr('光明模式') : tr('深色模式')}>
            {theme === 'dark' ? <ISun /> : <IMoon />}
          </button>
          {sync.config && (
            <button
              className={`syncdot sync-status${sync.status === 'error' ? ' err' : ''}${sync.status === 'syncing' ? ' busy' : ''}`}
              title={syncLabel(sync)}
              aria-label={`${syncLabel(sync)}${sync.status === 'error' ? tr('，打开设置') : tr('，点按立即同步')}`}
              onClick={() => (sync.status === 'error' ? go({ name: 'settings' }) : syncNow())}
            >
              <ICloud />
              <span className="t">{sync.status === 'syncing' ? tr('同步中') : sync.status === 'error' ? tr('同步失败') : sync.status === 'ok' ? tr('已同步') : tr('待同步')}</span>
            </button>
          )}
        </header>
        <main className="content" id="main">
          {!online && (
            <div className="banner warn" role="status">
              <span className="grow">{tr('当前离线。账单录入、查询和提醒照常可用；云端识别暂时不可用。')}</span>
            </div>
          )}
          {storageError && route.name !== 'data' && (
            <div className="banner bad" role="alert">
              <span className="grow">
                <b>{tx(storageError.message)}</b> — {tx(storageError.hint)}
              </span>
              <button className="btn btn-sm" onClick={() => go({ name: 'data' })}>
                {tr('数据管理')}
              </button>
            </div>
          )}
          {!ready ? (
            <div className="card empty">
              <span className="spin" />
              <p>{tr('正在打开本地数据…')}</p>
            </div>
          ) : (
            <div className="page" key={route.name}>
              <Suspense fallback={<PageLoading />}>
                <Page route={route} rem={rem} />
              </Suspense>
            </div>
          )}
        </main>
      </div>
      <nav className="tabbar" aria-label={tr('主导航')}>
        {nav.slice(0, 2).map((n) => (
          <button key={n.r.name} className="tab" data-tour={n.r.name} aria-current={isCurTab(n.r) ? 'page' : undefined} onClick={() => go(n.r)}>
            {n.icon}
            {n.label}
            {n.badge ? <span className="badge">{n.badge}</span> : null}
          </button>
        ))}
        <button className="tab tab-add" data-tour="add" onClick={openAdd} aria-label={tr('新增账单')}>
          <span className="plus">
            <IPlus />
          </span>
          <span>{tr('新增')}</span>
        </button>
        {nav.slice(2).map((n) => (
          <button key={n.r.name} className="tab" data-tour={n.r.name} aria-current={isCurTab(n.r) ? 'page' : undefined} onClick={() => go(n.r)}>
            {n.icon}
            {n.label}
          </button>
        ))}
      </nav>
      <PaywallModal />
      {searchOpen && (
        <Suspense fallback={null}>
          <SearchSheet onClose={() => setSearchOpen(false)} />
        </Suspense>
      )}
      <Tour autoStart={ready && shouldAutoStart({ saas: gate.saas, signedIn: !!auth.session, locked: lock.locked, route: route.name, done: tourDone() })} />
      {addOpen && (
        <Modal title={tr('新增账单')} onClose={() => setAddOpen(false)}>
          <div className="stack" onClick={() => setTimeout(() => setAddOpen(false), 0)}>
            <PickImageButton capture className="btn btn-primary btn-lg btn-block">
              <ICamera />
              {tr('拍照识别')}
            </PickImageButton>
            <PickImageButton className="btn btn-lg btn-block">
              <IImage />
              {tr('上传图片或 PDF')}
            </PickImageButton>
            <div className="grid2">
              <button className="btn btn-lg" onClick={() => go({ name: 'new' })}>
                <IEdit />
                {tr('商家账单')}
              </button>
              <button className="btn btn-lg" onClick={() => go({ name: 'new', kind: 'expense' })}>
                <IBolt />
                {tr('日常缴费')}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

function PageLoading() {
  return (
    <div className="card empty" aria-busy="true">
      <span className="spin" />
    </div>
  );
}

function Page({ route, rem }: { route: Route; rem: ReturnType<typeof useReminders> }) {
  const { gate } = useStore();
  // 只读（试用结束未订阅）：新增、编辑、识别页面换成订阅说明
  if (gate.readOnly && ['new', 'edit', 'copy', 'capture', 'review'].includes(route.name)) return <ReadOnlyPage />;
  switch (route.name) {
    case 'home':
      return <Dashboard />;
    case 'bills':
      return <Bills key={route.filter ?? ''} initialFilter={route.filter} />;
    case 'new':
      return <EditorPage key={`new-${route.kind ?? ''}`} mode="new" initialKind={route.kind} />;
    case 'edit':
      return <EditorPage key={`edit-${route.id}`} mode="edit" id={route.id} />;
    case 'copy':
      return <EditorPage key={`copy-${route.id}`} mode="new" copyFrom={route.id} />;
    case 'capture':
      return <CapturePage />;
    case 'review':
      return <EditorPage key="review" mode="review" />;
    case 'masters':
      return <Masters />;
    case 'settings':
      return <SettingsPage />;
    case 'set-remind':
      return <RemindSettingsPage rem={rem} />;
    case 'set-ai':
      return <AiSettingsPage />;
    case 'set-dev':
      return <DevSettingsPage />;
    case 'data':
      return <DataPage />;
    case 'account':
      return <AccountPage />;
    case 'help':
      return <HelpPage />;
    case 'report':
      return <ReportPage period={route.period} />;
    case 'cashflow':
      return <CashflowPage />;
    case 'reconcile':
      return <ReconcilePage />;
    case 'flow':
      return <FlowPage month={route.month} />;
  }
}


class Boundary extends Component<{ children: ReactNode }, { err: Error | null }> {
  state = { err: null as Error | null };
  static getDerivedStateFromError(err: Error) {
    return { err };
  }
  componentDidCatch(err: Error) {
    reportError(err);
  }
  render() {
    if (this.state.err) {
      return (
        <div className="content">
          <div className="card stack" role="alert">
            <h2>{tr('页面出错了')}</h2>
            <p className="small mono">{tx(this.state.err.message)}</p>
            <p className="small muted">{tr('本地数据不会因此丢失。')}</p>
            <div className="row">
              <button className="btn btn-primary" onClick={() => { location.hash = '#/'; location.reload(); }}>
                {tr('回到首页')}
              </button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

export default function App() {
  return (
    <Boundary>
      <FeedbackProvider>
        <StoreProvider>
          <Shell />
        </StoreProvider>
      </FeedbackProvider>
    </Boundary>
  );
}
