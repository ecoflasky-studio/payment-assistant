/**
 * 新手导览：第一次登录后在首页自动播放一次，高亮界面上的关键按钮并配一句说明。
 * 在「使用教程」里可以重新播放。目标元素用 data-tour 标记；找不到（或在当前屏幕上看不到）的步骤自动跳过。
 */
import { useCallback, useEffect, useLayoutEffect, useState } from 'react';

export const TOUR_DONE = 'zq.tour.done';
export const TOUR_EVENT = 'zq:tour';

export interface TourStep {
  /** data-tour 的值；没有就是居中的说明卡 */
  target?: string;
  title: string;
  text: string;
}

export const TOUR_STEPS: TourStep[] = [
  { title: '欢迎使用账期助手', text: '花 20 秒认识一下主要按钮。随时可以点「跳过」。右上角的放大镜可以搜索全部账单。' },
  { target: 'add', title: '新增账单', text: '从这里拍照识别、上传图片或 PDF，也可以手动录入商家账单和日常缴费。' },
  { target: 'capture', title: '拍照识别', text: '对准订单、boleto 或水电单拍一张，金额、到期日自动填好，你只需核对标黄的字段。' },
  { target: 'bills', title: '账单', text: '所有未付、逾期、即将到期的账单都在这里；付完点右侧 ✓ 标记已付。' },
  { target: 'flow', title: '报表', text: '流水、月报 / 年报、未来几周的现金流、每个商家的欠款和账龄都在这里。' },
  { target: 'settings', title: '设置', text: '商家账期、提醒、账号与套餐、面容 / 指纹解锁和使用教程都在这里。' },
  { title: '准备好了', text: '先拍一张单据试试吧。以后可以在「设置 → 使用教程」重新看这段导览。' },
];

export function tourDone(): boolean {
  try {
    return localStorage.getItem(TOUR_DONE) === '1';
  } catch {
    return true; // 存储不可用时不打扰
  }
}

export function markTourDone() {
  try {
    localStorage.setItem(TOUR_DONE, '1');
  } catch {}
}

export function startTour() {
  window.dispatchEvent(new Event(TOUR_EVENT));
}

export function shouldAutoStart(o: { saas: boolean; signedIn: boolean; locked: boolean; route: string; done: boolean }): boolean {
  return o.saas && o.signedIn && !o.locked && o.route === 'home' && !o.done;
}

export interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

/** 说明气泡放在目标下方，放不下就放上方；左右夹在屏幕内 */
export function placeBubble(r: Rect | null, vw: number, vh: number, bw: number, bh: number, gap = 12, margin = 12): { top: number; left: number; side: 'below' | 'above' | 'center' } {
  const w = Math.min(bw, vw - margin * 2);
  if (!r) return { top: Math.max(margin, (vh - bh) / 2), left: (vw - w) / 2, side: 'center' };
  const left = Math.min(Math.max(margin, r.left + r.width / 2 - w / 2), vw - w - margin);
  const below = r.top + r.height + gap;
  if (below + bh <= vh - margin) return { top: below, left, side: 'below' };
  const above = r.top - gap - bh;
  if (above >= margin) return { top: above, left, side: 'above' };
  return { top: Math.max(margin, Math.min(below, vh - bh - margin)), left, side: 'below' };
}

/** 找到当前屏幕上可见的那个目标（电脑侧栏和手机底栏都有「新增」） */
function findTarget(name: string): HTMLElement | null {
  const els = [...document.querySelectorAll<HTMLElement>(`[data-tour="${name}"]`)];
  return els.find((el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
  }) ?? null;
}

export function Tour({ autoStart }: { autoStart: boolean }) {
  const [i, setI] = useState<number | null>(null);
  const [rect, setRect] = useState<Rect | null>(null);
  const [size, setSize] = useState({ w: 320, h: 160 });

  useEffect(() => {
    const on = () => setI(0);
    window.addEventListener(TOUR_EVENT, on);
    return () => window.removeEventListener(TOUR_EVENT, on);
  }, []);
  useEffect(() => {
    if (!autoStart) return;
    const t = setTimeout(() => setI((cur) => cur ?? 0), 700);
    return () => clearTimeout(t);
  }, [autoStart]);

  const steps = TOUR_STEPS;
  const close = useCallback(() => {
    markTourDone();
    setI(null);
  }, []);

  // 跳过当前屏幕上看不到的步骤
  const resolve = useCallback(
    (from: number, dir: 1 | -1): number | null => {
      for (let k = from; k >= 0 && k < steps.length; k += dir) {
        const s = steps[k];
        if (!s.target || findTarget(s.target)) return k;
      }
      return null;
    },
    [steps],
  );

  const step = i == null ? null : steps[i];
  useLayoutEffect(() => {
    if (!step) return;
    const measure = () => {
      const el = step.target ? findTarget(step.target) : null;
      if (el) {
        el.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
        const r = el.getBoundingClientRect();
        setRect({ top: r.top - 6, left: r.left - 6, width: r.width + 12, height: r.height + 12 });
      } else setRect(null);
      const b = document.querySelector<HTMLElement>('.tour-bubble');
      if (b) setSize({ w: b.offsetWidth, h: b.offsetHeight });
    };
    measure();
    const raf = requestAnimationFrame(measure);
    window.addEventListener('resize', measure);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', measure);
    };
  }, [step]);

  useEffect(() => {
    if (i == null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
      else if (e.key === 'ArrowRight') next();
      else if (e.key === 'ArrowLeft') prev();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (i == null || !step) return null;
  const next = () => {
    const n = resolve(i + 1, 1);
    if (n == null) close();
    else setI(n);
  };
  const prev = () => {
    const n = resolve(i - 1, -1);
    if (n != null) setI(n);
  };
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const pos = placeBubble(rect, vw, vh, 320, size.h);
  const visible = steps.filter((s) => !s.target || findTarget(s.target));
  const idx = visible.indexOf(step);
  const last = resolve(i + 1, 1) == null;

  return (
    <div className="tour" role="dialog" aria-modal="true" aria-labelledby="tour-title" aria-describedby="tour-text">
      {rect ? <div key="hole" className="tour-hole" style={{ top: rect.top, left: rect.left, width: rect.width, height: rect.height }} /> : <div key="dim" className="tour-dim" />}
      <div key={i} className={`tour-bubble ${pos.side}`} style={{ top: pos.top, left: pos.left }}>
        <div className="tour-dots" aria-hidden="true">
          {visible.map((s, k) => (
            <i key={k} className={k === idx ? 'on' : ''} />
          ))}
        </div>
        <h3 id="tour-title">{step.title}</h3>
        <p id="tour-text" className="small">
          {step.text}
        </p>
        <div className="row">
          <button className="btn btn-ghost btn-sm" onClick={close}>
            {last ? '关闭' : '跳过'}
          </button>
          <span className="grow" />
          {idx > 0 && (
            <button className="btn btn-sm" onClick={prev}>
              上一步
            </button>
          )}
          <button className="btn btn-primary btn-sm tour-next" autoFocus onClick={next}>
            {last ? '开始使用' : idx === 0 ? '开始' : '下一步'}
          </button>
        </div>
        <span className="sr-only">
          第 {idx + 1} 步，共 {visible.length} 步
        </span>
      </div>
    </div>
  );
}
