/**
 * Page edge detection and perspective correction, dependency-free.
 *
 * detectPage() works on a small grayscale image (≈400–500px): Otsu threshold → largest
 * bright connected component (the paper) → corner extremes → sanity checks. It returns
 * null whenever it is not confident (page fills the frame, background as bright as the
 * paper, odd shapes) so the caller falls back to the full frame and text is never cut.
 */
export interface Pt { x: number; y: number }
/** Corners in normalized 0..1 coordinates: top-left, top-right, bottom-right, bottom-left. */
export type Quad = [Pt, Pt, Pt, Pt];

export function toGray(rgba: Uint8ClampedArray, w: number, h: number): Uint8Array {
  const g = new Uint8Array(w * h);
  for (let i = 0, j = 0; j < g.length; i += 4, j++) g[j] = (rgba[i] * 77 + rgba[i + 1] * 150 + rgba[i + 2] * 29) >> 8;
  return g;
}

export function otsu(gray: Uint8Array): number {
  const hist = new Float64Array(256);
  for (const v of gray) hist[v]++;
  const total = gray.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, best = 0, thr = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) ** 2;
    if (between > best) { best = between; thr = t; }
  }
  return thr;
}

export function polygonArea(q: Pt[]): number {
  let a = 0;
  for (let i = 0; i < q.length; i++) {
    const p = q[i], n = q[(i + 1) % q.length];
    a += p.x * n.y - n.x * p.y;
  }
  return Math.abs(a) / 2;
}

function isConvex(q: Pt[]): boolean {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i], b = q[(i + 1) % 4], c = q[(i + 2) % 4];
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (cross === 0) continue;
    if (sign === 0) sign = Math.sign(cross);
    else if (Math.sign(cross) !== sign) return false;
  }
  return true;
}

export interface Detection { quad: Quad; coverage: number }

export function detectPage(gray: Uint8Array, w: number, h: number): Detection | null {
  const thr = otsu(gray);
  // Paper must be clearly brighter than the background.
  let fg = 0, bgSum = 0, fgSum = 0;
  for (const v of gray) { if (v > thr) { fg++; fgSum += v; } else bgSum += v; }
  const bgN = gray.length - fg;
  if (fg === 0 || bgN === 0 || fgSum / fg - bgSum / bgN < 40) return null;

  // Largest 4-connected bright component.
  const label = new Int32Array(w * h).fill(-1);
  const stack = new Int32Array(w * h);
  let bestId = -1, bestSize = 0;
  for (let s = 0, id = 0; s < w * h; s++) {
    if (gray[s] <= thr || label[s] !== -1) continue;
    let top = 0, size = 0;
    stack[top++] = s;
    label[s] = id;
    while (top) {
      const p = stack[--top];
      size++;
      const x = p % w, y = (p - x) / w;
      const nb = [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, y > 0 ? p - w : -1, y < h - 1 ? p + w : -1];
      for (const n of nb) if (n >= 0 && label[n] === -1 && gray[n] > thr) { label[n] = id; stack[top++] = n; }
    }
    if (size > bestSize) { bestSize = size; bestId = id; }
    id++;
  }
  if (bestId < 0) return null;

  let minS = Infinity, maxS = -Infinity, minD = Infinity, maxD = -Infinity;
  let tl: Pt = { x: 0, y: 0 }, br = tl, tr = tl, bl = tl;
  let edgeTop = 0, edgeBottom = 0, edgeLeft = 0, edgeRight = 0;
  for (let p = 0; p < w * h; p++) {
    if (label[p] !== bestId) continue;
    const x = p % w, y = (p - x) / w;
    const s = x + y, d = x - y;
    if (s < minS) { minS = s; tl = { x, y }; }
    if (s > maxS) { maxS = s; br = { x, y }; }
    if (d > maxD) { maxD = d; tr = { x, y }; }
    if (d < minD) { minD = d; bl = { x, y }; }
    if (y === 0) edgeTop++;
    if (y === h - 1) edgeBottom++;
    if (x === 0) edgeLeft++;
    if (x === w - 1) edgeRight++;
  }
  // Paper running off the frame on 2+ sides: edges are not visible, don't guess.
  const touching = [edgeTop > w * 0.25, edgeBottom > w * 0.25, edgeLeft > h * 0.25, edgeRight > h * 0.25].filter(Boolean).length;
  if (touching >= 2) return null;

  const quad: Quad = [tl, tr, br, bl];
  const qa = polygonArea(quad);
  const coverage = qa / (w * h);
  if (coverage < 0.15 || coverage > 0.97 || !isConvex(quad)) return null;
  // The component should look like a filled quadrilateral (text holes are small).
  const fill = bestSize / qa;
  if (fill < 0.6 || fill > 1.1) return null;
  return { quad: quad.map((p) => ({ x: p.x / w, y: p.y / h })) as Quad, coverage };
}

/** Grow a quad outward from its centroid (normalized), clamped to the frame. */
export function expandQuad(q: Quad, margin: number): Quad {
  const cx = (q[0].x + q[1].x + q[2].x + q[3].x) / 4;
  const cy = (q[0].y + q[1].y + q[2].y + q[3].y) / 4;
  return q.map((p) => ({
    x: Math.min(1, Math.max(0, cx + (p.x - cx) * (1 + margin))),
    y: Math.min(1, Math.max(0, cy + (p.y - cy) * (1 + margin))),
  })) as Quad;
}

/** Output size (pixels) for a quad in a srcW×srcH image, limited to maxSide. */
export function outputSize(q: Quad, srcW: number, srcH: number, maxSide: number): { w: number; h: number } {
  const d = (a: Pt, b: Pt) => Math.hypot((a.x - b.x) * srcW, (a.y - b.y) * srcH);
  let w = (d(q[0], q[1]) + d(q[3], q[2])) / 2;
  let h = (d(q[0], q[3]) + d(q[1], q[2])) / 2;
  const s = Math.min(1, maxSide / Math.max(w, h));
  return { w: Math.max(1, Math.round(w * s)), h: Math.max(1, Math.round(h * s)) };
}

/** Homography H (row-major 3×3, h33=1) mapping src points → dst points. */
export function homography(src: Pt[], dst: Pt[]): number[] {
  const A: number[][] = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = src[i], { x: u, y: v } = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
  }
  for (let c = 0; c < 8; c++) {
    let piv = c;
    for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
    [A[c], A[piv]] = [A[piv], A[c]];
    const div = A[c][c] || 1e-12;
    for (let k = c; k < 9; k++) A[c][k] /= div;
    for (let r = 0; r < 8; r++) {
      if (r === c) continue;
      const f = A[r][c];
      for (let k = c; k < 9; k++) A[r][k] -= f * A[c][k];
    }
  }
  return [A[0][8], A[1][8], A[2][8], A[3][8], A[4][8], A[5][8], A[6][8], A[7][8], 1];
}

/**
 * Perspective-warp the quad region of src into a dstW×dstH rectangle (bilinear).
 * quadPx: corners in source pixel coordinates (TL, TR, BR, BL).
 */
export function warp(src: Uint8ClampedArray, sw: number, sh: number, quadPx: Pt[], dw: number, dh: number, out: Uint8ClampedArray): void {
  const H = homography([{ x: 0, y: 0 }, { x: dw - 1, y: 0 }, { x: dw - 1, y: dh - 1 }, { x: 0, y: dh - 1 }], quadPx);
  let o = 0;
  for (let y = 0; y < dh; y++) {
    for (let x = 0; x < dw; x++, o += 4) {
      const z = H[6] * x + H[7] * y + 1;
      let sx = (H[0] * x + H[1] * y + H[2]) / z;
      let sy = (H[3] * x + H[4] * y + H[5]) / z;
      sx = Math.min(sw - 1.001, Math.max(0, sx));
      sy = Math.min(sh - 1.001, Math.max(0, sy));
      const x0 = sx | 0, y0 = sy | 0, fx = sx - x0, fy = sy - y0;
      const i00 = (y0 * sw + x0) * 4, i10 = i00 + 4, i01 = i00 + sw * 4, i11 = i01 + 4;
      for (let c = 0; c < 3; c++) {
        const top = src[i00 + c] + (src[i10 + c] - src[i00 + c]) * fx;
        const bot = src[i01 + c] + (src[i11 + c] - src[i01 + c]) * fx;
        out[o + c] = top + (bot - top) * fy;
      }
      out[o + 3] = 255;
    }
  }
}
