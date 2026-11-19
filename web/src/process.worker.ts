/// <reference lib="webworker" />
import { jpegInfo } from './jpeg';
import { detectPage, expandQuad, outputSize, toGray, warp, type Quad } from './pagedetect';

export type CropMode = 'off' | 'auto' | 'guide';
export interface Rect { x: number; y: number; w: number; h: number }

export interface ProcessRequest {
  type: 'process';
  id: number;
  blob?: Blob;
  bitmap?: ImageBitmap;
  maxSide: number; // 0 = native (never upscale either way)
  quality: number;
  crop: CropMode;
  guide: Rect | null;
  margin: number;
}
export interface DetectRequest { type: 'detect'; id: number; bitmap: ImageBitmap }
export interface ProcessResponse {
  id: number;
  blob?: Blob;
  checksum?: string;
  width?: number;
  height?: number;
  srcWidth?: number;
  srcHeight?: number;
  cropped?: 'auto' | 'guide' | null;
  passthrough?: boolean;
  quad?: Quad | null;
  timings?: Record<string, number>;
  error?: string;
}
export interface DetectResponse { id: number; quad: Quad | null; ms: number }

const DETECT = 480;
const post = (m: unknown) => (self as unknown as Worker).postMessage(m);

async function sha256(buf: ArrayBuffer): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function detectOn(src: ImageBitmap | OffscreenCanvas, sw: number, sh: number): Quad | null {
  const s = Math.min(1, DETECT / Math.max(sw, sh));
  const dw = Math.max(1, Math.round(sw * s)), dh = Math.max(1, Math.round(sh * s));
  const small = new OffscreenCanvas(dw, dh);
  const sctx = small.getContext('2d', { willReadFrequently: true })!;
  sctx.drawImage(src, 0, 0, dw, dh);
  return detectPage(toGray(sctx.getImageData(0, 0, dw, dh).data, dw, dh), dw, dh)?.quad ?? null;
}

async function process(r: ProcessRequest): Promise<ProcessResponse> {
  const t: Record<string, number> = {};
  let mark = performance.now();
  const lap = (k: string) => { const n = performance.now(); t[k] = Math.round((n - mark) * 10) / 10; mark = n; };

  // Fast path: camera JPEG that already fits and needs no crop → store the bytes untouched.
  if (r.blob && r.crop === 'off' && r.blob.type === 'image/jpeg') {
    const buf = await r.blob.arrayBuffer();
    const info = jpegInfo(buf);
    if (info && (r.maxSide === 0 || Math.max(info.width, info.height) <= r.maxSide)) {
      lap('read_ms');
      const checksum = await sha256(buf);
      lap('checksum_ms');
      return { id: r.id, blob: r.blob, checksum, width: info.width, height: info.height, srcWidth: info.width, srcHeight: info.height, cropped: null, passthrough: true, quad: null, timings: t };
    }
  }

  const bmp = r.bitmap ?? await createImageBitmap(r.blob!, { imageOrientation: 'from-image' } as ImageBitmapOptions);
  lap('decode_ms');
  const sw = bmp.width, sh = bmp.height;
  let quad: Quad | null = null;
  let cropped: 'auto' | 'guide' | null = null;
  if (r.crop === 'auto') {
    const q = detectOn(bmp, sw, sh);
    lap('detect_ms');
    if (q) { quad = expandQuad(q, r.margin); cropped = 'auto'; }
  }
  if (!quad && r.crop === 'guide' && r.guide) {
    const m = r.margin;
    const g = { x: Math.max(0, r.guide.x - m * r.guide.w), y: Math.max(0, r.guide.y - m * r.guide.h), w: 0, h: 0 };
    g.w = Math.min(1 - g.x, r.guide.w * (1 + 2 * m));
    g.h = Math.min(1 - g.y, r.guide.h * (1 + 2 * m));
    quad = [{ x: g.x, y: g.y }, { x: g.x + g.w, y: g.y }, { x: g.x + g.w, y: g.y + g.h }, { x: g.x, y: g.y + g.h }];
    cropped = 'guide';
  }
  const limit = r.maxSide > 0 ? r.maxSide : Infinity;
  let out: OffscreenCanvas;
  if (quad && cropped === 'auto') {
    const { w, h } = outputSize(quad, sw, sh, limit === Infinity ? Math.max(sw, sh) : limit);
    const full = new OffscreenCanvas(sw, sh);
    const fctx = full.getContext('2d', { willReadFrequently: true })!;
    fctx.drawImage(bmp, 0, 0);
    const src = fctx.getImageData(0, 0, sw, sh);
    out = new OffscreenCanvas(w, h);
    const octx = out.getContext('2d')!;
    const dst = octx.createImageData(w, h);
    warp(src.data, sw, sh, quad.map((p) => ({ x: p.x * (sw - 1), y: p.y * (sh - 1) })), w, h, dst.data);
    octx.putImageData(dst, 0, 0);
    full.width = full.height = 0;
    lap('warp_ms');
  } else {
    const cx = quad ? Math.round(quad[0].x * sw) : 0, cy = quad ? Math.round(quad[0].y * sh) : 0;
    const cw = quad ? Math.round((quad[1].x - quad[0].x) * sw) : sw, ch = quad ? Math.round((quad[3].y - quad[0].y) * sh) : sh;
    const s = Math.min(1, limit / Math.max(cw, ch));
    out = new OffscreenCanvas(Math.max(1, Math.round(cw * s)), Math.max(1, Math.round(ch * s)));
    const octx = out.getContext('2d')!;
    octx.imageSmoothingQuality = 'high';
    octx.drawImage(bmp, cx, cy, cw, ch, 0, 0, out.width, out.height);
    lap('resize_ms');
  }
  bmp.close();
  const blob = await out.convertToBlob({ type: 'image/jpeg', quality: r.quality });
  lap('encode_ms');
  const checksum = await sha256(await blob.arrayBuffer());
  lap('checksum_ms');
  return { id: r.id, blob, checksum, width: out.width, height: out.height, srcWidth: sw, srcHeight: sh, cropped, passthrough: false, quad, timings: t };
}

self.onmessage = async (e: MessageEvent<ProcessRequest | DetectRequest>) => {
  const r = e.data;
  if (r.type === 'detect') {
    const t0 = performance.now();
    let quad: Quad | null = null;
    try { quad = detectOn(r.bitmap, r.bitmap.width, r.bitmap.height); } catch { quad = null; }
    r.bitmap.close();
    post({ id: r.id, quad, ms: performance.now() - t0 } satisfies DetectResponse);
    return;
  }
  try {
    post(await process(r));
  } catch (err) {
    r.bitmap?.close();
    post({ id: r.id, error: (err as Error).message } satisfies ProcessResponse);
  }
};
