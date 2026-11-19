import { describe, expect, it } from 'vitest';
import { detectPage, expandQuad, homography, outputSize, warp, type Pt } from '../src/pagedetect';

/** Dark table with a bright (slightly rotated) paper quad and some "text" holes. */
function scene(w: number, h: number, corners: Pt[], bg = 40, paper = 235): Uint8Array {
  const g = new Uint8Array(w * h).fill(bg);
  const inside = (x: number, y: number) => {
    let sign = 0;
    for (let i = 0; i < 4; i++) {
      const a = corners[i], b = corners[(i + 1) % 4];
      const c = Math.sign((b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x));
      if (c === 0) continue;
      if (!sign) sign = c; else if (c !== sign) return false;
    }
    return true;
  };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!inside(x, y)) continue;
    const text = y % 12 < 2 && x % 9 < 6; // thin dark lines like print
    g[y * w + x] = text ? 30 : paper;
  }
  return g;
}

describe('detectPage', () => {
  it('finds a skewed page on a dark table', () => {
    const c = [{ x: 90, y: 40 }, { x: 330, y: 60 }, { x: 310, y: 380 }, { x: 70, y: 360 }];
    const d = detectPage(scene(400, 420, c), 400, 420);
    expect(d).not.toBeNull();
    const q = d!.quad.map((p) => ({ x: p.x * 400, y: p.y * 420 }));
    q.forEach((p, i) => {
      expect(Math.abs(p.x - c[i].x)).toBeLessThan(6);
      expect(Math.abs(p.y - c[i].y)).toBeLessThan(6);
    });
  });

  it('returns null when the page fills the frame (no visible edges)', () => {
    const g = new Uint8Array(400 * 300).fill(230);
    for (let i = 0; i < g.length; i += 7) g[i] = 20;
    expect(detectPage(g, 400, 300)).toBeNull();
  });

  it('returns null when background is as bright as paper', () => {
    const c = [{ x: 50, y: 50 }, { x: 350, y: 50 }, { x: 350, y: 250 }, { x: 50, y: 250 }];
    expect(detectPage(scene(400, 300, c, 220, 235), 400, 300)).toBeNull();
  });

  it('returns null for a small bright object', () => {
    const c = [{ x: 10, y: 10 }, { x: 60, y: 10 }, { x: 60, y: 60 }, { x: 10, y: 60 }];
    expect(detectPage(scene(400, 300, c), 400, 300)).toBeNull();
  });
});

describe('geometry', () => {
  it('homography maps corners exactly', () => {
    const src = [{ x: 0, y: 0 }, { x: 99, y: 0 }, { x: 99, y: 49 }, { x: 0, y: 49 }];
    const dst = [{ x: 10, y: 5 }, { x: 200, y: 20 }, { x: 190, y: 130 }, { x: 5, y: 120 }];
    const H = homography(src, dst);
    src.forEach((p, i) => {
      const z = H[6] * p.x + H[7] * p.y + 1;
      expect((H[0] * p.x + H[1] * p.y + H[2]) / z).toBeCloseTo(dst[i].x, 6);
      expect((H[3] * p.x + H[4] * p.y + H[5]) / z).toBeCloseTo(dst[i].y, 6);
    });
  });

  it('warp of an axis-aligned rect equals a plain crop', () => {
    const sw = 20, sh = 10;
    const src = new Uint8ClampedArray(sw * sh * 4);
    for (let i = 0; i < sw * sh; i++) { src[i * 4] = i % 256; src[i * 4 + 3] = 255; }
    const out = new Uint8ClampedArray(5 * 4 * 4);
    warp(src, sw, sh, [{ x: 2, y: 3 }, { x: 6, y: 3 }, { x: 6, y: 6 }, { x: 2, y: 6 }], 5, 4, out);
    expect(out[0]).toBe(3 * sw + 2);
    expect(out[(3 * 5 + 4) * 4]).toBe(6 * sw + 6);
  });

  it('expandQuad grows and clamps; outputSize respects maxSide', () => {
    const q = expandQuad([{ x: 0.1, y: 0.1 }, { x: 0.9, y: 0.1 }, { x: 0.9, y: 0.9 }, { x: 0.1, y: 0.9 }], 0.5);
    expect(q[0].x).toBeCloseTo(0, 5);
    expect(q[2].y).toBeCloseTo(1, 5);
    const s = outputSize(q, 4000, 3000, 2000);
    expect(Math.max(s.w, s.h)).toBe(2000);
  });
});
