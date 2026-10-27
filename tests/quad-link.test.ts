import { describe, it, expect } from 'vitest';
import { dragCorner, moveQuad, boundingRect, isAxisRect, checkQuad } from '../src/lib/image/geometry';

const R = (x0: number, y0: number, x1: number, y1: number) => [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];

describe('识别范围：四角联动', () => {
  it('拖左上角：右上角的 y、左下角的 x 跟着变，仍是矩形', () => {
    const q = dragCorner(R(100, 100, 500, 700), 0, { x: 50, y: 150 }, true, 1000, 1000);
    expect(q).toEqual(R(50, 150, 500, 700));
    expect(isAxisRect(q)).toBe(true);
    expect(checkQuad(q).ok).toBe(true);
  });
  it('拖右下角', () => {
    expect(dragCorner(R(100, 100, 500, 700), 2, { x: 800, y: 900 }, true, 1000, 1000)).toEqual(R(100, 100, 800, 900));
  });
  it('拖过对角不翻转，保留最小尺寸；不出图片边界', () => {
    const q = dragCorner(R(100, 100, 500, 700), 0, { x: 900, y: 900 }, true, 1000, 1000, 50);
    expect(q).toEqual(R(450, 650, 500, 700));
    expect(checkQuad(q).ok).toBe(true);
    expect(dragCorner(R(100, 100, 500, 700), 1, { x: 2000, y: -50 }, true, 1000, 1000)).toEqual(R(100, 0, 1000, 700));
  });
  it('自由四角：只动一个角', () => {
    const q = dragCorner(R(100, 100, 500, 700), 1, { x: 520, y: 140 }, false, 1000, 1000);
    expect(q[1]).toEqual({ x: 520, y: 140 });
    expect(q[0]).toEqual({ x: 100, y: 100 });
    expect(isAxisRect(q)).toBe(false);
    expect(boundingRect(q)).toEqual(R(100, 100, 520, 700));
  });
  it('整体平移，碰到边就停', () => {
    expect(moveQuad(R(100, 100, 500, 700), 50, -30, 1000, 1000)).toEqual(R(150, 70, 550, 670));
    expect(moveQuad(R(100, 100, 500, 700), -300, 900, 1000, 1000)).toEqual(R(0, 400, 400, 1000));
  });
});
