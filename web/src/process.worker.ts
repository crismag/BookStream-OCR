/// <reference lib="webworker" />
import { detectPage, expandQuad, outputSize, toGray, warp, type Quad } from './pagedetect';

export interface ProcessRequest { id: number; blob: Blob; maxSide: number; quality: number; autoCrop: boolean; margin: number }
export interface ProcessResponse {
  id: number;
  blob?: Blob;
  width?: number;
  height?: number;
  srcWidth?: number;
  srcHeight?: number;
  cropped?: boolean;
  quad?: Quad | null;
  error?: string;
}

const DETECT = 480;

self.onmessage = async (e: MessageEvent<ProcessRequest>) => {
  const { id, blob, maxSide, quality, autoCrop, margin } = e.data;
  try {
    const bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' } as ImageBitmapOptions);
    const sw = bmp.width, sh = bmp.height;
    let quad: Quad | null = null;
    if (autoCrop) {
      const s = DETECT / Math.max(sw, sh);
      const dw = Math.max(1, Math.round(sw * s)), dh = Math.max(1, Math.round(sh * s));
      const small = new OffscreenCanvas(dw, dh);
      const sctx = small.getContext('2d', { willReadFrequently: true })!;
      sctx.drawImage(bmp, 0, 0, dw, dh);
      const det = detectPage(toGray(sctx.getImageData(0, 0, dw, dh).data, dw, dh), dw, dh);
      quad = det ? expandQuad(det.quad, margin) : null;
    }
    let out: OffscreenCanvas;
    if (quad) {
      const { w, h } = outputSize(quad, sw, sh, maxSide);
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
    } else {
      const s = Math.min(1, maxSide / Math.max(sw, sh));
      out = new OffscreenCanvas(Math.round(sw * s), Math.round(sh * s));
      const octx = out.getContext('2d')!;
      octx.imageSmoothingQuality = 'high';
      octx.drawImage(bmp, 0, 0, out.width, out.height);
    }
    bmp.close();
    const result = await out.convertToBlob({ type: 'image/jpeg', quality });
    const res: ProcessResponse = { id, blob: result, width: out.width, height: out.height, srcWidth: sw, srcHeight: sh, cropped: !!quad, quad };
    (self as unknown as Worker).postMessage(res);
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, error: (err as Error).message } satisfies ProcessResponse);
  }
};
