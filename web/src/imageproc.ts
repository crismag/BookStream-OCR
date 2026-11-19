import { prepareForUpload } from './camera';
import type { ProcessRequest, ProcessResponse } from './process.worker';
import type { Quad } from './pagedetect';

export interface Processed {
  blob: Blob;
  width: number;
  height: number;
  srcWidth: number;
  srcHeight: number;
  cropped: boolean;
  quad: Quad | null;
}

let worker: Worker | null = null;
let seq = 0;
const waiting = new Map<number, (r: ProcessResponse) => void>();

function getWorker(): Worker | null {
  if (worker) return worker;
  if (typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined') return null;
  try {
    worker = new Worker(new URL('./process.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<ProcessResponse>) => {
      waiting.get(e.data.id)?.(e.data);
      waiting.delete(e.data.id);
    };
    worker.onerror = () => { worker = null; };
  } catch {
    worker = null;
  }
  return worker;
}

/**
 * Crop to the detected page (perspective-corrected) and/or resize, off the main thread.
 * Falls back to a plain main-thread resize if workers/OffscreenCanvas are unavailable
 * or processing fails, so a capture is never lost.
 */
export async function processCapture(blob: Blob, opts: { maxSide: number; quality: number; autoCrop: boolean }): Promise<Processed> {
  const w = getWorker();
  if (w) {
    const id = ++seq;
    const res = await new Promise<ProcessResponse>((resolve) => {
      waiting.set(id, resolve);
      const req: ProcessRequest = { id, blob, maxSide: opts.maxSide, quality: opts.quality, autoCrop: opts.autoCrop, margin: 0.03 };
      w.postMessage(req);
    });
    if (res.blob) {
      return { blob: res.blob, width: res.width!, height: res.height!, srcWidth: res.srcWidth!, srcHeight: res.srcHeight!, cropped: !!res.cropped, quad: res.quad ?? null };
    }
  }
  const r = await prepareForUpload(blob, opts.maxSide, opts.quality);
  return { ...r, srcWidth: r.width, srcHeight: r.height, cropped: false, quad: null };
}
