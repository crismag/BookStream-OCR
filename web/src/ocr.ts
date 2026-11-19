import { createWorker, OEM, PSM, type Worker } from 'tesseract.js';
import { api } from './api';

/**
 * Browser OCR with self-hosted Tesseract.js. Each region is cropped from the page
 * image and recognized as one block, preserving line breaks. For languages without a
 * dedicated model (e.g. Maranao → Latin "eng" model) dictionaries are disabled at
 * init so unfamiliar words are not pulled toward English spellings.
 */
export const ENGINE = 'tesseract.js';
export const ENGINE_VERSION = '5.1.1+eng-4.0.0_best_int';
const BASE = '/vendor/tesseract';
const LOW_WORD_CONF = 60;

export interface JobRegion {
  id: string;
  bbox: { x: number; y: number; w: number; h: number };
  lang: string;
  tesseract_lang: string;
  use_dictionary: boolean;
  block_type: string;
}

export interface RegionResult {
  region_id: string;
  text: string;
  confidence: number;
  flagged_words: string[];
  engine: string;
  engine_version: string;
  language: string;
  settings: Record<string, unknown>;
}

const workers = new Map<string, Promise<Worker>>();

function worker(lang: string, dict: boolean): Promise<Worker> {
  const key = `${lang}:${dict ? 'dict' : 'nodict'}`;
  let w = workers.get(key);
  if (!w) {
    const init: Record<string, string> = dict ? {} : { load_system_dawg: '0', load_freq_dawg: '0' };
    w = createWorker(lang, OEM.LSTM_ONLY, {
      workerPath: `${BASE}/worker.min.js`,
      corePath: BASE,
      langPath: `${BASE}/lang`,
      gzip: false,
      workerBlobURL: false,
    }, init);
    workers.set(key, w);
  }
  return w;
}

export async function terminateAll(): Promise<void> {
  for (const w of workers.values()) (await w).terminate();
  workers.clear();
}

/** Crop + grayscale + contrast stretch on a copy (the stored original is never touched). */
export function cropForOcr(src: ImageBitmap, bbox: JobRegion['bbox']): HTMLCanvasElement {
  const sx = Math.round(bbox.x * src.width);
  const sy = Math.round(bbox.y * src.height);
  const sw = Math.max(1, Math.round(bbox.w * src.width));
  const sh = Math.max(1, Math.round(bbox.h * src.height));
  const pad = 24;
  const c = document.createElement('canvas');
  c.width = sw + pad * 2;
  c.height = sh + pad * 2;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(src, sx, sy, sw, sh, pad, pad, sw, sh);
  const img = ctx.getImageData(0, 0, c.width, c.height);
  const d = img.data;
  const hist = new Uint32Array(256);
  for (let i = 0; i < d.length; i += 4) {
    const g = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000;
    d[i] = d[i + 1] = d[i + 2] = g;
    hist[g | 0]++;
  }
  const total = d.length / 4;
  let lo = 0, hi = 255, acc = 0;
  for (; lo < 255 && (acc += hist[lo]) < total * 0.01; lo++);
  acc = 0;
  for (; hi > 0 && (acc += hist[hi]) < total * 0.01; hi--);
  const range = Math.max(1, hi - lo);
  for (let i = 0; i < d.length; i += 4) {
    const v = Math.max(0, Math.min(255, ((d[i] - lo) * 255) / range));
    d[i] = d[i + 1] = d[i + 2] = v;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

export async function recognizeRegion(page: ImageBitmap, r: JobRegion): Promise<RegionResult> {
  const w = await worker(r.tesseract_lang, r.use_dictionary);
  await w.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_BLOCK, preserve_interword_spaces: '1' });
  const canvas = cropForOcr(page, r.bbox);
  const { data } = await w.recognize(canvas, {}, { text: true, blocks: true });
  canvas.width = canvas.height = 0;
  const flagged: string[] = [];
  for (const b of data.blocks ?? []) for (const p of b.paragraphs) for (const l of p.lines) for (const wd of l.words) {
    if (wd.confidence < LOW_WORD_CONF) flagged.push(wd.text);
  }
  return {
    region_id: r.id,
    text: data.text.replace(/\s+$/, ''),
    confidence: Math.round(data.confidence * 10) / 10,
    flagged_words: flagged,
    engine: ENGINE,
    engine_version: ENGINE_VERSION,
    language: r.tesseract_lang,
    settings: { psm: 'SINGLE_BLOCK', oem: 'LSTM_ONLY', dictionaries: r.use_dictionary, preprocess: 'gray+stretch', declared_lang: r.lang },
  };
}

export interface Job {
  id: string;
  lease_token: string;
  book_id: string;
  page_id: string;
  printed_page_number: string | null;
  image_url: string;
  regions: JobRegion[];
}

/** Lease → OCR → submit, once. Returns null when no job is available. */
export async function processOne(bookId: string | null, log: (s: string) => void, stop: () => boolean): Promise<Job | null> {
  const { job } = await api<{ job: Job | null }>('POST', '/api/ocr/lease', bookId ? { book_id: bookId } : {});
  if (!job) return null;
  const label = job.printed_page_number ? `p.${job.printed_page_number}` : job.page_id.slice(0, 8);
  try {
    const res = await fetch(job.image_url, { credentials: 'same-origin' });
    if (!res.ok) throw new Error(`image ${res.status}`);
    const bmp = await createImageBitmap(await res.blob());
    const results: RegionResult[] = [];
    for (const r of job.regions) {
      if (stop()) throw new Error('stopped by user');
      log(`${label}: region ${r.lang}/${r.block_type}…`);
      results.push(await recognizeRegion(bmp, r));
    }
    bmp.close();
    const out = await api<{ status: string }>('POST', `/api/ocr/jobs/${job.id}/complete`, { lease_token: job.lease_token, results });
    log(`${label}: ${out.status.replace('_', ' ')}`);
  } catch (e) {
    log(`${label}: failed — ${(e as Error).message}`);
    await api('POST', `/api/ocr/jobs/${job.id}/fail`, { lease_token: job.lease_token, error: (e as Error).message }).catch(() => undefined);
  }
  return job;
}
