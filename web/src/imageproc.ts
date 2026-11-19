import { prepareForUpload } from './camera';
import type { Acquired } from './camera';
import { sha256Hex } from './queue';
import type { CropMode, DetectResponse, ProcessRequest, ProcessResponse, Rect } from './process.worker';
import type { Quad } from './pagedetect';

export type { CropMode, Rect };

export interface Processed {
  blob: Blob;
  checksum: string;
  width: number;
  height: number;
  srcWidth: number;
  srcHeight: number;
  cropped: 'auto' | 'guide' | null;
  passthrough: boolean;
  quad: Quad | null;
  timings: Record<string, number>;
}

let worker: Worker | null = null;
let seq = 0;
const waiting = new Map<number, (r: any) => void>();

function getWorker(): Worker | null {
  if (worker) return worker;
  if (typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined') return null;
  try {
    worker = new Worker(new URL('./process.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<ProcessResponse | DetectResponse>) => {
      waiting.get(e.data.id)?.(e.data);
      waiting.delete(e.data.id);
    };
    worker.onerror = () => { worker = null; };
  } catch {
    worker = null;
  }
  return worker;
}

export function workerAvailable(): boolean {
  return getWorker() !== null;
}

/**
 * Prepare a capture off the main thread: optional crop (auto edges or guide box),
 * downsample to maxSide (0 = native; never upscale), JPEG encode once, SHA-256.
 * Camera JPEGs that already fit and need no crop are stored byte-for-byte.
 * Falls back to a main-thread resize if workers are unavailable, so a capture is never lost.
 */
export async function processCapture(src: Acquired, opts: { maxSide: number; quality: number; crop: CropMode; guide: Rect | null }): Promise<Processed> {
  const w = getWorker();
  if (w) {
    const id = ++seq;
    const req: ProcessRequest = { type: 'process', id, maxSide: opts.maxSide, quality: opts.quality, crop: opts.crop, guide: opts.guide, margin: 0.03 };
    const transfer: Transferable[] = [];
    if (src.kind === 'bitmap') { req.bitmap = src.bitmap; transfer.push(src.bitmap); } else req.blob = src.blob;
    const res = await new Promise<ProcessResponse>((resolve) => { waiting.set(id, resolve); w.postMessage(req, transfer); });
    if (res.blob && res.checksum) {
      return { blob: res.blob, checksum: res.checksum, width: res.width!, height: res.height!, srcWidth: res.srcWidth!, srcHeight: res.srcHeight!, cropped: res.cropped ?? null, passthrough: !!res.passthrough, quad: res.quad ?? null, timings: res.timings ?? {} };
    }
    if (src.kind === 'bitmap') throw new Error(res.error ?? 'processing failed');
  }
  // Fallback (no worker): plain resize on the main thread.
  let blob: Blob;
  if (src.kind === 'bitmap') {
    const c = document.createElement('canvas');
    c.width = src.width; c.height = src.height;
    c.getContext('2d')!.drawImage(src.bitmap, 0, 0);
    src.bitmap.close();
    blob = await new Promise<Blob>((r, j) => c.toBlob((b) => (b ? r(b) : j(new Error('encode failed'))), 'image/jpeg', opts.quality));
  } else blob = src.blob;
  const r = await prepareForUpload(blob, opts.maxSide, opts.quality);
  return { ...r, checksum: await sha256Hex(r.blob), srcWidth: r.width, srcHeight: r.height, cropped: null, passthrough: r.blob === blob, quad: null, timings: {} };
}

/** Live edge detection on a small preview bitmap, in the worker. */
export async function detectInWorker(bitmap: ImageBitmap): Promise<DetectResponse | null> {
  const w = getWorker();
  if (!w) { bitmap.close(); return null; }
  const id = ++seq;
  return new Promise((resolve) => { waiting.set(id, resolve); w.postMessage({ type: 'detect', id, bitmap }, [bitmap]); });
}
