import { api } from '../api';
import { Camera, type Acquired } from '../camera';
import { detectInWorker, processCapture, type Rect } from '../imageproc';
import { heapMB, record, summary } from '../metrics';
import { startOcrLoop, workerIdentity } from '../ocr';
import type { Quad } from '../pagedetect';
import { advancePageNumber, uuid, type PendingCapture } from '../queue';
import { go } from '../router';
import { onQueueChange, queue, setUploadLater, uploader, type Book } from '../state';
import { PRESETS, effectiveQuality, fmtBytes, h, mount, preset, settings, toast, type CropSetting, type GuideAspect } from '../ui';

type Mode = 'single' | 'spread';
interface OcrStatus { queued: number; leased: number; done: number; failed: number; worker_active: boolean; workers: { label: string; busy: boolean }[]; oldest_queued_seconds: number | null }

const ASPECTS: Record<Exclude<GuideAspect, 'auto' | 'custom'>, number> = { a4: 1 / Math.SQRT2, letter: 8.5 / 11 };
const MAX_PROCESSING = 3;

/**
 * Scanner. Capture path: acquire (preview frame or still) → shutter ready again →
 * worker prepares image (crop/resize/encode/checksum) → IndexedDB → upload queue.
 * Status indicators update in place (throttled); nothing re-renders the screen.
 */
export async function scanView(root: HTMLElement, bookId: string): Promise<() => void> {
  sessionStorage.setItem('bs.currentBook', bookId);
  const { book } = await api<{ book: Book }>('GET', `/api/books/${bookId}`);
  const pending = await queue.all(bookId);
  const sessionId = uuid();
  const nextKey = `bs.next.${bookId}`;
  const modeKey = `bs.mode.${bookId}`;

  let nextIndex = Math.max(book.next_capture_index, ...pending.map((p) => p.captureIndex + 1), 1);
  let printed: string | null = localStorage.getItem(nextKey) ?? book.next_printed_page ?? (book.stats.pages === 0 ? '1' : null);
  let mode: Mode = (localStorage.getItem(modeKey) as Mode) || 'single';
  let sessionSaved = 0;
  let processing = 0;
  let acquiring = false;
  let paused = false;
  let lastActivity = 0;
  let last: { captureId: string; pages: number; printedBefore: string | null } | null = null;
  let chain: Promise<void> = Promise.resolve();
  let wake: any = null;
  let liveQuad: Quad | null = null;
  let intervalTimer: ReturnType<typeof setInterval> | null = null;
  let countdown: ReturnType<typeof setInterval> | null = null;
  let stopLocalOcr: (() => void) | null = null;
  let ocr: OcrStatus | null = null;
  const camera = new Camera();

  // ---------- elements ----------
  const video = h('video', { class: 'preview', playsinline: true, muted: true, autoplay: true, 'aria-label': 'Camera preview' });
  const overlay = h('canvas', { class: 'overlay', 'aria-hidden': 'true' });
  const flash = h('div', { class: 'flash', 'aria-hidden': 'true' });
  const countdownEl = h('div', { class: 'countdown', hidden: true, 'aria-live': 'assertive' });
  const pausedEl = h('div', { class: 'pausedcover', hidden: true }, h('p', null, 'Scanning paused — camera off'), h('button', { class: 'primary big', onclick: () => void resume() }, '▶ Resume scanning'));
  const fallback = h('div', { class: 'camfallback', hidden: true });
  const pageBtn = h('button', { class: 'pagebtn', title: 'Set the printed page number of the next capture' });
  const shutter = h('button', { class: 'shutter', 'aria-label': 'Capture page' }, h('span', null));
  const presetBtn = h('button', { class: 'chip', title: 'Saved image resolution' });
  const cropBtn = h('button', { class: 'chip', title: 'Crop: off, to the guide box, or to detected page edges' });
  const modeBtn = h('button', { class: 'chip', title: 'Minimal = lowest load, no live detection' });
  const moreBtn = h('button', { class: 'chip', 'aria-expanded': 'false' }, '⋯ More');
  const st = {
    local: h('span', { class: 'ind' }), up: h('span', { class: 'ind' }), stored: h('span', { class: 'ind' }),
    ocr: h('button', { class: 'ind ocrind' }), last: h('span', { class: 'ind lastind' }), hint: h('span', { class: 'ind hint' }),
  };
  const statusbar = h('div', { class: 'statusbar', role: 'status', 'aria-live': 'polite' }, st.local, st.up, st.stored, st.ocr, st.last, st.hint);
  const fileInput = h('input', { type: 'file', accept: 'image/*', capture: 'environment', hidden: true });

  // Advanced panel
  const sel = <T extends string>(opts: [T, string][], val: T, on: (v: T) => void) =>
    h('select', { onchange: (e: Event) => on((e.target as HTMLSelectElement).value as T) }, opts.map(([v, l]) => h('option', { value: v, selected: v === val }, l)));
  const torchBtn = h('button', { class: 'tool', hidden: true }, '☀ Light');
  const focusRow = h('label', { hidden: true }, 'Focus');
  const uploadBtn = h('button', { class: 'tool' });
  const intervalBtn = h('button', { class: 'tool' });
  const localOcrBtn = h('button', { class: 'tool' });
  const diag = h('pre', { class: 'diag' });
  const panel = h('div', { class: 'advpanel', hidden: true },
    h('div', { class: 'advgrid' },
      h('button', { class: 'tool', onclick: () => { mode = mode === 'single' ? 'spread' : 'single'; localStorage.setItem(modeKey, mode); labels(); } }, h('span', { id: 'modelbl' })),
      torchBtn,
      h('button', { class: 'tool', id: 'undo', disabled: true, onclick: () => void undo() }, '↶ Undo last'),
      h('button', { class: 'tool', onclick: () => void pause() }, '❚❚ Pause scanning'),
      uploadBtn,
      h('button', { class: 'tool', onclick: () => void uploader.retryNow() }, '↻ Retry uploads'),
      h('button', { class: 'tool', onclick: () => fileInput.click() }, '🖼 From camera app'),
      h('button', { class: 'tool', onclick: () => go(`/books/${bookId}/pages`) }, '✓ Finish'),
    ),
    h('label', null, 'Page guide', sel<GuideAspect>([['auto', 'Auto (whole frame)'], ['a4', 'A4'], ['letter', 'Letter'], ['custom', 'Custom ratio']], settings.guideAspect, (v) => { settings.guideAspect = v; drawOverlay(); })),
    h('label', null, 'Custom page width ÷ height', h('input', { type: 'number', step: 0.01, min: 0.3, max: 2, value: settings.customRatio, onchange: (e: Event) => { settings.customRatio = Number((e.target as HTMLInputElement).value) || 0.68; drawOverlay(); } })),
    h('label', null, 'Guide size', h('input', { type: 'range', min: 50, max: 98, value: Math.round(settings.guideScale * 100), oninput: (e: Event) => { settings.guideScale = Number((e.target as HTMLInputElement).value) / 100; drawOverlay(); } })),
    focusRow,
    h('label', null, 'Self-timer', sel<string>([['0', 'Off'], ['3', '3 s'], ['5', '5 s'], ['10', '10 s']], String(settings.timer), (v) => { settings.timer = Number(v); })),
    h('div', { class: 'row2' },
      h('label', null, 'Hands-free every (s)', h('input', { type: 'number', min: 2, max: 60, value: settings.interval, onchange: (e: Event) => { settings.interval = Math.max(2, Number((e.target as HTMLInputElement).value) || 6); } })),
      h('div', null, intervalBtn)),
    h('label', null, 'JPEG quality', sel<string>([['0', 'Preset default'], ['0.75', '75%'], ['0.8', '80%'], ['0.85', '85%'], ['0.9', '90%'], ['0.95', '95%']], String(settings.qualityOverride), (v) => { settings.qualityOverride = Number(v); labels(); })),
    h('label', null, 'Parallel uploads', sel<string>([['1', '1'], ['2', '2 (default)'], ['3', '3'], ['4', '4']], String(settings.concurrency), (v) => { settings.concurrency = Number(v); uploader.setConcurrency(Number(v)); })),
    localOcrBtn,
    h('details', null, h('summary', null, 'Diagnostics (measured on this phone)'), diag),
  );

  // ---------- labels & status (incremental, throttled) ----------
  const labels = () => {
    const p = preset();
    presetBtn.textContent = `▣ ${p.label} ${p.maxSide ? p.maxSide + 'px' : 'native'}`;
    const crop = effectiveCrop();
    cropBtn.textContent = crop === 'off' ? '⬚ Crop off' : crop === 'guide' ? '⬚ Crop: guide' : '⬚ Crop: auto edges';
    cropBtn.setAttribute('aria-pressed', String(crop !== 'off'));
    modeBtn.textContent = settings.minimal ? '◌ Minimal' : '◉ Enhanced';
    modeBtn.setAttribute('aria-pressed', String(settings.minimal));
    pageBtn.textContent = mode === 'spread'
      ? `p. ${printed ?? '—'}${printed && /^\d+$/.test(printed) ? `–${+printed + 1}` : ''} ✎`
      : `p. ${printed ?? '—'} ✎`;
    const ml = document.getElementById('modelbl');
    if (ml) ml.textContent = mode === 'spread' ? '▯▯ Two pages per photo' : '▯ One page per photo';
    uploadBtn.textContent = uploader.paused ? '⏸ Upload later (on)' : '☁ Upload now';
    intervalBtn.textContent = intervalTimer ? '■ Stop hands-free' : '▶ Start hands-free';
    localOcrBtn.textContent = settings.localOcr ? '⚙ OCR on this phone: ON (pauses while you capture)' : '⚙ OCR on this phone: off';
    drawOverlay();
  };

  let statusQueued = false;
  let lastStatus = 0;
  const status = () => {
    if (statusQueued) return;
    statusQueued = true;
    const wait = Math.max(0, (settings.minimal ? 1000 : 300) - (Date.now() - lastStatus));
    setTimeout(() => requestAnimationFrame(async () => {
      statusQueued = false;
      lastStatus = Date.now();
      const items = await queue.all(bookId);
      const total = await queue.count();
      const n = (s: string) => items.filter((i) => i.status === s).length;
      st.local.textContent = `💾 ${items.length} on phone`;
      st.local.classList.toggle('warn', total >= settings.maxPending * 0.8);
      const blocked = n('blocked');
      st.up.textContent = !navigator.onLine ? '○ offline' : uploader.paused ? '⏸ upload later' : n('uploading') ? `↑ ${n('uploading')} uploading` : n('retrying') ? `↻ ${n('retrying')} retrying` : items.length ? '↑ waiting' : '✓ all uploaded';
      st.up.classList.toggle('warn', !navigator.onLine || blocked > 0);
      if (blocked) st.up.textContent += ` · ✕ ${blocked} need attention`;
      st.stored.textContent = `☁ ${sessionSaved} this session`;
      if (ocr) {
        const running = ocr.leased > 0;
        st.ocr.textContent = ocr.queued + ocr.leased === 0
          ? `OCR ✓ ${ocr.done} done`
          : `OCR ${ocr.queued} queued${running ? ` · ⟳ ${ocr.leased} running` : ''}${ocr.worker_active ? '' : ' · ⚠ no worker'}`;
        st.ocr.classList.toggle('warn', ocr.queued > 0 && !ocr.worker_active);
      }
      const full = total >= settings.maxPending;
      shutter.disabled = full || paused;
      if (full) st.hint.textContent = `Queue full (${total}). Upload before capturing more.`;
    }), wait);
  };

  // ---------- page guide & live outline ----------
  /** Displayed video rectangle inside the stage (object-fit: contain). */
  const videoBox = () => {
    const r = video.getBoundingClientRect();
    const vw = video.videoWidth || 4, vhh = video.videoHeight || 3;
    const k = Math.min(r.width / vw, r.height / vhh);
    return { x: (r.width - vw * k) / 2, y: (r.height - vhh * k) / 2, w: vw * k, h: vhh * k, cw: r.width, ch: r.height };
  };
  /** Guide rectangle, normalized to the camera frame. */
  const guideRect = (): Rect => {
    const vb = videoBox();
    const s = settings.guideScale;
    if (settings.guideAspect === 'auto') return { x: (1 - s) / 2, y: (1 - s) / 2, w: s, h: s };
    let ratio = settings.guideAspect === 'custom' ? settings.customRatio : ASPECTS[settings.guideAspect];
    if (mode === 'spread') ratio *= 2;
    let gw = vb.w * s, gh = gw / ratio;
    if (gh > vb.h * s) { gh = vb.h * s; gw = gh * ratio; }
    return { x: (vb.w - gw) / 2 / vb.w, y: (vb.h - gh) / 2 / vb.h, w: gw / vb.w, h: gh / vb.h };
  };
  const drawOverlay = () => {
    const vb = videoBox();
    overlay.width = Math.round(vb.cw);
    overlay.height = Math.round(vb.ch);
    const ctx = overlay.getContext('2d')!;
    ctx.clearRect(0, 0, overlay.width, overlay.height);
    const g = guideRect();
    const gx = vb.x + g.x * vb.w, gy = vb.y + g.y * vb.h, gw = g.w * vb.w, gh = g.h * vb.h;
    // dim outside the guide, dashed guide, spine line for spreads
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fillRect(0, 0, overlay.width, gy);
    ctx.fillRect(0, gy + gh, overlay.width, overlay.height - gy - gh);
    ctx.fillRect(0, gy, gx, gh);
    ctx.fillRect(gx + gw, gy, overlay.width - gx - gw, gh);
    ctx.setLineDash([10, 8]);
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.strokeRect(gx, gy, gw, gh);
    if (mode === 'spread') { ctx.strokeStyle = 'rgba(251,191,36,0.9)'; ctx.beginPath(); ctx.moveTo(gx + gw / 2, gy); ctx.lineTo(gx + gw / 2, gy + gh); ctx.stroke(); }
    ctx.setLineDash([]);
    if (liveQuad && effectiveCrop() === 'auto') {
      ctx.strokeStyle = '#22c55e';
      ctx.lineWidth = 4;
      ctx.beginPath();
      liveQuad.forEach((p, i) => (i ? ctx.lineTo : ctx.moveTo).call(ctx, vb.x + p.x * vb.w, vb.y + p.y * vb.h));
      ctx.closePath();
      ctx.stroke();
    }
  };
  const effectiveCrop = (): CropSetting => (settings.minimal && settings.crop === 'auto' ? 'guide' : settings.crop);

  // Live detection: Enhanced + auto crop only, ~2/s, in the worker, paused while capturing.
  let detecting = false;
  const detectTimer = setInterval(async () => {
    if (settings.minimal || effectiveCrop() !== 'auto' || paused || detecting || acquiring || processing > 0 || !camera.stream || !video.videoWidth || document.hidden) {
      if (liveQuad && (settings.minimal || effectiveCrop() !== 'auto')) { liveQuad = null; drawOverlay(); st.hint.textContent = ''; }
      return;
    }
    detecting = true;
    try {
      const scale = 360 / Math.max(video.videoWidth, video.videoHeight);
      const bmp = await createImageBitmap(video, { resizeWidth: Math.round(video.videoWidth * scale), resizeHeight: Math.round(video.videoHeight * scale), resizeQuality: 'low' } as ImageBitmapOptions);
      const res = await detectInWorker(bmp);
      if (res) {
        record('live_detect_ms', res.ms);
        liveQuad = res.quad;
        st.hint.textContent = res.quad ? '✓ page edges found' : '○ edges not visible — full frame kept';
        drawOverlay();
      }
    } catch { /* detection is optional */ } finally { detecting = false; }
  }, 500);

  // ---------- capture ----------
  const doCapture = async () => {
    if (paused || acquiring || shutter.disabled) return;
    if (processing >= MAX_PROCESSING) { st.hint.textContent = 'processing previous photos…'; return; }
    if ((await queue.count()) >= settings.maxPending) { toast('Upload queue is full. Capture not taken.', 'error'); return; }
    acquiring = true;
    lastActivity = Date.now();
    // Reserve order and numbering at shutter time (independent of processing/upload timing).
    const captureId = uuid();
    const index = nextIndex++;
    const pages = mode === 'spread' ? 2 : 1;
    const thisPrinted = printed;
    const thisMode = mode;
    printed = advancePageNumber(printed, pages);
    if (printed !== null) localStorage.setItem(nextKey, printed); else localStorage.removeItem(nextKey);
    last = { captureId, pages, printedBefore: thisPrinted };
    navigator.vibrate?.(20);
    flash.classList.remove('on'); void flash.offsetWidth; flash.classList.add('on');
    const p = preset();
    const t0 = performance.now();
    let acq: Acquired;
    try {
      acq = await camera.acquire(video, p.maxSide || null);
    } catch (e) {
      acquiring = false;
      printed = thisPrinted; nextIndex = Math.max(nextIndex, index + 1);
      toast(`Capture failed: ${(e as Error).message}`, 'error');
      return;
    }
    const acquireMs = performance.now() - t0;
    record('acquire_ms', acquireMs);
    record(`ready_ms_${p.key}`, acquireMs);
    acquiring = false; // shutter is free for the next page now
    labels();
    processing++;
    chain = chain.then(() => persist(acq, { captureId, index, mode: thisMode, printed: thisPrinted, preset: p.key, acquireMs, t0 }))
      .catch((e) => toast(`Could not save capture: ${(e as Error).message}`, 'error'))
      .finally(() => { processing--; status(); });
  };

  const persist = async (acq: Acquired, c: { captureId: string; index: number; mode: Mode; printed: string | null; preset: string; acquireMs: number; t0: number }) => {
    const pr = PRESETS.find((x) => x.key === c.preset) ?? preset();
    const proc = await processCapture(acq, { maxSide: pr.maxSide, quality: settings.qualityOverride > 0 ? settings.qualityOverride : pr.quality, crop: effectiveCrop(), guide: effectiveCrop() === 'guide' ? guideRect() : null });
    const t1 = performance.now();
    const metrics: Record<string, number> = { acquire_ms: Math.round(c.acquireMs), ...proc.timings, width: proc.width, height: proc.height, bytes: proc.blob.size, passthrough: proc.passthrough ? 1 : 0, frame: acq.kind === 'bitmap' ? 1 : 0 };
    const item: PendingCapture = {
      captureId: c.captureId, bookId, captureIndex: c.index, mode: c.mode, printedPageNumber: c.printed, sessionId,
      blob: proc.blob, checksum: proc.checksum, size: proc.blob.size, width: proc.width, height: proc.height, createdAt: Date.now(),
      status: 'pending', attempts: 0, lastError: null, nextAttemptAt: 0, metrics,
    };
    await queue.put(item); // durable: only now is the capture "saved locally"
    const idbMs = performance.now() - t1;
    metrics.idb_ms = Math.round(idbMs);
    record('idb_ms', idbMs);
    record('prepare_ms', t1 - c.t0 - c.acquireMs);
    record(`saved_total_ms_${c.preset}`, performance.now() - c.t0);
    for (const [k, v] of Object.entries(proc.timings)) record(k, v);
    sessionSaved++;
    (document.getElementById('undo') as HTMLButtonElement | null)?.removeAttribute('disabled');
    st.last.textContent = `${proc.width}×${proc.height} · ${fmtBytes(proc.blob.size)}${proc.cropped ? ` · cropped (${proc.cropped})` : ''}${proc.passthrough ? ' · original' : ''}`;
    uploader.kick();
    status();
  };

  const capture = () => {
    if (settings.timer > 0 && !intervalTimer) {
      if (countdown) return;
      let left = settings.timer;
      countdownEl.hidden = false;
      countdownEl.textContent = String(left);
      countdown = setInterval(() => {
        left--;
        if (left <= 0) { clearInterval(countdown!); countdown = null; countdownEl.hidden = true; void doCapture(); } else countdownEl.textContent = String(left);
      }, 1000);
      return;
    }
    void doCapture();
  };

  const undo = async () => {
    if (!last) return;
    const l = last;
    await chain;
    const inQueue = await queue.get(l.captureId);
    if (inQueue && inQueue.status !== 'uploading') {
      await queue.remove(l.captureId);
    } else {
      if (!window.confirm('The last capture is already stored on the server. Remove its page(s) from the book? (The photo is kept on the server.)')) return;
      const { pages } = await api<{ pages: { id: string; capture_id: string }[] }>('GET', `/api/books/${bookId}/pages`);
      for (const p of pages.filter((p) => p.capture_id === l.captureId)) await api('DELETE', `/api/pages/${p.id}`, { confirm: true });
    }
    printed = l.printedBefore;
    if (printed !== null) localStorage.setItem(nextKey, printed);
    sessionSaved = Math.max(0, sessionSaved - 1);
    last = null;
    document.getElementById('undo')?.setAttribute('disabled', '');
    labels();
    status();
    toast('Last capture removed — retake it', 'ok');
  };

  const toggleInterval = () => {
    if (intervalTimer) { clearInterval(intervalTimer); intervalTimer = null; toast('Hands-free capture stopped'); }
    else {
      intervalTimer = setInterval(() => void doCapture(), settings.interval * 1000);
      toast(`Hands-free: a photo every ${settings.interval} s. Turn pages between flashes. Tap ■ to stop.`, 'ok');
    }
    labels();
  };

  // ---------- camera lifecycle ----------
  const startCamera = async () => {
    fallback.hidden = true;
    if (!Camera.supported()) return showFallback('This browser does not expose the live camera.');
    try {
      const caps = await camera.start(video);
      torchBtn.hidden = !caps.torch;
      if (caps.manualFocus) {
        const mf = caps.manualFocus;
        focusRow.hidden = false;
        mount(focusRow, 'Focus (manual)', h('input', { type: 'range', min: mf.min, max: mf.max, step: mf.step, oninput: (e: Event) => void camera.setFocus(Number((e.target as HTMLInputElement).value)) }),
          h('button', { class: 'small', onclick: () => void camera.setFocus(null) }, 'Auto focus'));
      }
      const sw = caps.stillWidth;
      st.hint.textContent = `preview ${caps.videoWidth}×${caps.videoHeight}${sw ? ` · stills ${sw.min}–${sw.max}px` : ' · frame capture'}`;
      requestAnimationFrame(drawOverlay);
    } catch (e) {
      const name = (e as DOMException).name;
      showFallback(name === 'NotAllowedError'
        ? 'Camera permission was denied. Tap the lock icon in the address bar → Permissions → Camera → Allow, then tap “Try camera again”.'
        : `Camera unavailable (${(e as Error).message}).`);
    }
  };
  const showFallback = (msg: string) => {
    mount(fallback, h('p', null, msg),
      h('button', { class: 'primary', onclick: () => fileInput.click() }, 'Take photo with camera app'),
      h('button', { onclick: () => void startCamera() }, 'Try camera again'));
    fallback.hidden = false;
  };
  const pause = async () => {
    paused = true;
    if (intervalTimer) toggleInterval();
    camera.stop();
    pausedEl.hidden = false;
    panel.hidden = true;
    status();
  };
  const resume = async () => {
    paused = false;
    pausedEl.hidden = true;
    await startCamera();
    status();
  };
  const requestWake = async () => { try { wake = await (navigator as any).wakeLock?.request('screen'); } catch { wake = null; } };
  const onVisible = () => {
    if (document.visibilityState === 'visible') { if (!paused) void startCamera(); void requestWake(); }
    else { camera.stop(); if (intervalTimer) toggleInterval(); }
  };
  const onResize = () => requestAnimationFrame(drawOverlay);
  const onKey = (e: KeyboardEvent) => { if (['Space', 'AudioVolumeUp', 'VolumeUp', 'AudioVolumeDown', 'VolumeDown'].includes(e.code) || ['AudioVolumeUp', 'AudioVolumeDown'].includes(e.key)) { e.preventDefault(); capture(); } };

  // ---------- OCR status & optional local OCR ----------
  const pollOcr = async () => {
    if (document.hidden) return;
    try { ocr = await api<OcrStatus>('GET', `/api/books/${bookId}/ocr/status`); status(); } catch { /* offline */ }
  };
  const ocrTimer = setInterval(pollOcr, 8000);
  const setLocalOcr = (on: boolean) => {
    settings.localOcr = on;
    stopLocalOcr?.();
    stopLocalOcr = on ? startOcrLoop(bookId, (s) => { st.hint.textContent = s; }, () => !paused && processing === 0 && !acquiring && !intervalTimer && Date.now() - lastActivity > 8000) : null;
    labels();
  };
  st.ocr.addEventListener('click', () => {
    if (ocr && ocr.queued > 0 && !ocr.worker_active) {
      if (confirm('No OCR worker is running.\n\nOK = run OCR on this phone between captures (uses battery; pauses while you scan).\nCancel = I will open “Process” on a laptop instead.')) setLocalOcr(true);
    } else go(`/books/${bookId}/pages`);
  });

  // ---------- wiring ----------
  shutter.addEventListener('click', capture);
  fileInput.addEventListener('change', () => {
    const f = fileInput.files?.[0];
    if (f) {
      const captureId = uuid(), index = nextIndex++, thisPrinted = printed, t0 = performance.now();
      printed = advancePageNumber(printed, mode === 'spread' ? 2 : 1);
      processing++;
      chain = chain.then(() => persist({ kind: 'blob', blob: f, method: 'still', requestedWidth: null }, { captureId, index, mode, printed: thisPrinted, preset: preset().key, acquireMs: 0, t0 }))
        .catch((e) => toast((e as Error).message, 'error')).finally(() => { processing--; labels(); status(); });
    }
    fileInput.value = '';
  });
  presetBtn.addEventListener('click', () => {
    const i = PRESETS.findIndex((p) => p.key === settings.preset);
    const next = PRESETS[(i + 1) % PRESETS.length];
    settings.preset = next.key;
    labels();
    toast(`${next.label}: ${next.maxSide ? `long edge ${next.maxSide}px` : 'native camera resolution'}, JPEG ${Math.round(effectiveQuality() * 100)}%`);
  });
  cropBtn.addEventListener('click', () => {
    const order: CropSetting[] = settings.minimal ? ['off', 'guide'] : ['off', 'guide', 'auto'];
    settings.crop = order[(order.indexOf(effectiveCrop()) + 1) % order.length];
    labels();
  });
  modeBtn.addEventListener('click', () => {
    settings.minimal = !settings.minimal;
    if (settings.minimal) { liveQuad = null; if (settings.localOcr) setLocalOcr(false); }
    labels();
    toast(settings.minimal ? 'Minimal: no live detection, fewer updates — lowest load' : 'Enhanced: live page-edge outline');
  });
  moreBtn.addEventListener('click', () => {
    panel.hidden = !panel.hidden;
    moreBtn.setAttribute('aria-expanded', String(!panel.hidden));
    if (!panel.hidden) {
      const s = summary();
      const row = (k: string) => (s[k] ? `${k.padEnd(22)} p50 ${String(s[k].p50).padStart(7)}  p95 ${String(s[k].p95).padStart(7)}  n=${s[k].n}` : null);
      diag.textContent = [
        ...['acquire_ms', 'prepare_ms', 'decode_ms', 'detect_ms', 'warp_ms', 'resize_ms', 'encode_ms', 'checksum_ms', 'idb_ms', 'upload_ms', 'server_ms', 'live_detect_ms'].map(row),
        ...PRESETS.map((p) => row(`ready_ms_${p.key}`)), ...PRESETS.map((p) => row(`saved_total_ms_${p.key}`)),
        heapMB() !== null ? `JS heap ${heapMB()} MB` : null,
        `uploads in parallel: ${uploader.effective}/${uploader.concurrency} · worker id ${workerIdentity().worker_label}`,
      ].filter(Boolean).join('\n') || 'No samples yet.';
    }
  });
  pageBtn.addEventListener('click', () => {
    const v = window.prompt('Printed page number of the NEXT capture (left page for spreads). Empty = unnumbered; roman numerals are fine.', printed ?? '');
    if (v === null) return;
    printed = v.trim() === '' ? null : v.trim();
    if (printed !== null) localStorage.setItem(nextKey, printed); else localStorage.removeItem(nextKey);
    labels();
  });
  uploadBtn.addEventListener('click', () => { setUploadLater(!uploader.paused); labels(); status(); });
  intervalBtn.addEventListener('click', toggleInterval);
  localOcrBtn.addEventListener('click', () => setLocalOcr(!settings.localOcr));
  torchBtn.addEventListener('click', async () => { const ok = await camera.setTorch(!camera.torch); torchBtn.setAttribute('aria-pressed', String(camera.torch)); if (!ok) toast('Light not available', 'error'); });
  video.addEventListener('click', async (ev) => {
    const r = video.getBoundingClientRect();
    if (await camera.focusAt((ev.clientX - r.left) / r.width, (ev.clientY - r.top) / r.height)) toast('Focusing…');
  });
  document.addEventListener('visibilitychange', onVisible);
  window.addEventListener('resize', onResize);
  window.addEventListener('keydown', onKey);
  const off = onQueueChange(status);

  mount(root,
    h('div', { class: 'scan' },
      h('div', { class: 'scanbar top' },
        h('button', { class: 'tool', onclick: () => go('/'), 'aria-label': 'Back to dashboard' }, '←'),
        h('div', { class: 'scantitle' }, h('strong', null, book.title)),
        pageBtn),
      h('div', { class: 'stage' }, video, overlay, flash, countdownEl, pausedEl, fallback),
      statusbar,
      h('div', { class: 'controls' },
        h('div', { class: 'chips' }, presetBtn, cropBtn, modeBtn, moreBtn),
        shutter),
      panel,
      fileInput));

  labels();
  status();
  void pollOcr();
  if (settings.localOcr && !settings.minimal) setLocalOcr(true);
  await startCamera();
  void requestWake();

  return () => {
    camera.stop();
    clearInterval(detectTimer);
    clearInterval(ocrTimer);
    if (intervalTimer) clearInterval(intervalTimer);
    if (countdown) clearInterval(countdown);
    stopLocalOcr?.();
    off();
    document.removeEventListener('visibilitychange', onVisible);
    window.removeEventListener('resize', onResize);
    window.removeEventListener('keydown', onKey);
    try { wake?.release(); } catch { /* ignore */ }
  };
}
