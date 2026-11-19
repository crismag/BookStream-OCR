import { api } from '../api';
import { Camera, prepareForUpload } from '../camera';
import { advancePageNumber, sha256Hex, uuid, type PendingCapture } from '../queue';
import { go } from '../router';
import { onQueueChange, queue, uploader, type Book } from '../state';
import { h, mount, settings, toast } from '../ui';

type Mode = 'single' | 'spread';

export async function scanView(root: HTMLElement, bookId: string): Promise<() => void> {
  sessionStorage.setItem('bs.currentBook', bookId);
  const { book } = await api<{ book: Book }>('GET', `/api/books/${bookId}`);
  const pending = await queue.all(bookId);
  const sessionId = uuid();
  const nextKey = `bs.next.${bookId}`;
  const modeKey = `bs.mode.${bookId}`;

  let nextIndex = Math.max(book.next_capture_index, ...pending.map((p) => p.captureIndex + 1), 1);
  let printed: string | null = localStorage.getItem(nextKey) ?? book.next_printed_page ?? (book.stats.pages === 0 ? '1' : null);
  let mode: Mode = (localStorage.getItem(modeKey) as Mode) || (book.default_layout === 'parallel' ? 'single' : 'single');
  let sessionCount = 0;
  let last: { captureId: string; pages: number; printedBefore: string | null; indexBefore: number } | null = null;
  let chain: Promise<void> = Promise.resolve();
  let wake: any = null;
  const camera = new Camera();

  const video = h('video', { class: 'preview', playsinline: true, muted: true, autoplay: true, 'aria-label': 'Camera preview' });
  const guide = h('div', { class: 'guide', 'aria-hidden': 'true' });
  const flash = h('div', { class: 'flash', 'aria-hidden': 'true' });
  const lastThumb = h('canvas', { class: 'lastthumb', width: 96, height: 72, 'aria-label': 'Last capture' });
  const pageLabel = h('button', { class: 'pagebtn', title: 'Set the printed page number' });
  const counts = h('span', { class: 'counts' });
  const queueStat = h('span', { class: 'queuestat', role: 'status', 'aria-live': 'polite' });
  const camInfo = h('span', { class: 'muted small caminfo' });
  const shutter = h('button', { class: 'shutter', 'aria-label': 'Capture page' }, h('span', null));
  const modeBtn = h('button', { class: 'tool' });
  const torchBtn = h('button', { class: 'tool', hidden: true }, '☀ Light');
  const pauseBtn = h('button', { class: 'tool' });
  const undoBtn = h('button', { class: 'tool', disabled: true }, '↶ Undo');
  const retryBtn = h('button', { class: 'tool', hidden: true }, '↻ Retry');
  const fileInput = h('input', { type: 'file', accept: 'image/*', capture: 'environment', hidden: true });
  const fallback = h('div', { class: 'camfallback', hidden: true });

  const renderLabels = () => {
    pageLabel.textContent = mode === 'spread'
      ? `Pages ${printed ?? '—'}${printed && /^\d+$/.test(printed) ? `–${+printed + 1}` : ''} ✎`
      : `Page ${printed ?? '(unnumbered)'} ✎`;
    modeBtn.textContent = mode === 'spread' ? '▯▯ Spread' : '▯ Single';
    modeBtn.setAttribute('aria-pressed', String(mode === 'spread'));
    guide.className = `guide ${mode}`;
    counts.textContent = `${sessionCount} this session · ${book.stats.pages} stored before`;
    pauseBtn.textContent = uploader.paused ? '▶ Resume uploads' : '❚❚ Pause uploads';
  };

  const renderQueue = async () => {
    const items = await queue.all();
    const mine = items.filter((i) => i.bookId === bookId);
    const by = (s: string) => mine.filter((i) => i.status === s).length;
    const blocked = by('blocked');
    const parts = [
      navigator.onLine ? '● Online' : '○ Offline',
      mine.length === 0 ? '✓ All uploaded' : `${mine.length} pending`,
      by('uploading') ? '↑ uploading' : '',
      by('retrying') ? `↻ ${by('retrying')} retrying` : '',
      blocked ? `✕ ${blocked} need attention` : '',
      uploader.paused ? '❚❚ paused' : '',
    ].filter(Boolean);
    queueStat.textContent = parts.join(' · ');
    queueStat.classList.toggle('warn', blocked > 0 || !navigator.onLine);
    retryBtn.hidden = !(by('retrying') || blocked);
    const full = items.length >= settings.maxPending;
    shutter.disabled = full;
    shutter.title = full ? 'Upload queue full — wait for uploads' : 'Capture';
    if (full) toast(`Queue full (${items.length}). Waiting for uploads before more captures.`, 'error');
  };

  const showThumb = async (blob: Blob) => {
    try {
      const bmp = await createImageBitmap(blob, { resizeWidth: 96, resizeQuality: 'low' } as ImageBitmapOptions);
      const ctx = lastThumb.getContext('2d')!;
      lastThumb.height = Math.round((96 * bmp.height) / bmp.width);
      ctx.drawImage(bmp, 0, 0, lastThumb.width, lastThumb.height);
      bmp.close();
    } catch { /* thumbnail is cosmetic */ }
  };

  const enqueue = async (raw: Blob) => {
    if ((await queue.count()) >= settings.maxPending) {
      toast('Upload queue is full. Capture not taken.', 'error');
      return;
    }
    const { blob } = await prepareForUpload(raw, settings.maxSide, settings.quality);
    const checksum = await sha256Hex(blob);
    const pages = mode === 'spread' ? 2 : 1;
    const item: PendingCapture = {
      captureId: uuid(), bookId, captureIndex: nextIndex, mode, printedPageNumber: printed, sessionId,
      blob, checksum, size: blob.size, createdAt: Date.now(), status: 'pending', attempts: 0, lastError: null, nextAttemptAt: 0,
    };
    await queue.put(item); // durable before we advance counters
    last = { captureId: item.captureId, pages, printedBefore: printed, indexBefore: nextIndex };
    nextIndex++;
    printed = advancePageNumber(printed, pages);
    if (printed !== null) localStorage.setItem(nextKey, printed); else localStorage.removeItem(nextKey);
    sessionCount++;
    undoBtn.disabled = false;
    renderLabels();
    void showThumb(blob);
    uploader.kick();
    void renderQueue();
  };

  const capture = () => {
    if (shutter.disabled) return;
    navigator.vibrate?.(25);
    flash.classList.remove('on');
    void flash.offsetWidth;
    flash.classList.add('on');
    const taken = camera.stream ? camera.capture(video).then((r) => r.blob) : Promise.reject(new Error('Camera not running'));
    chain = chain.then(() => taken.then(enqueue)).catch((e) => toast(`Capture failed: ${(e as Error).message}`, 'error'));
  };

  shutter.addEventListener('click', capture);
  fileInput.addEventListener('change', () => {
    const f = fileInput.files?.[0];
    if (f) chain = chain.then(() => enqueue(f)).catch((e) => toast((e as Error).message, 'error'));
    fileInput.value = '';
  });
  modeBtn.addEventListener('click', () => { mode = mode === 'single' ? 'spread' : 'single'; localStorage.setItem(modeKey, mode); renderLabels(); });
  pageLabel.addEventListener('click', () => {
    const v = window.prompt('Printed page number of the NEXT capture (left page for spreads). Leave empty for unnumbered pages; roman numerals are fine.', printed ?? '');
    if (v === null) return;
    printed = v.trim() === '' ? null : v.trim();
    if (printed !== null) localStorage.setItem(nextKey, printed); else localStorage.removeItem(nextKey);
    renderLabels();
  });
  pauseBtn.addEventListener('click', () => { uploader.paused = !uploader.paused; if (!uploader.paused) uploader.kick(); renderLabels(); void renderQueue(); });
  retryBtn.addEventListener('click', () => void uploader.retryNow());
  torchBtn.addEventListener('click', async () => {
    const ok = await camera.setTorch(!camera.torch);
    torchBtn.setAttribute('aria-pressed', String(camera.torch));
    if (!ok) toast('Light not available', 'error');
  });
  undoBtn.addEventListener('click', async () => {
    if (!last) return;
    const l = last;
    const inQueue = await queue.get(l.captureId);
    if (inQueue && inQueue.status !== 'uploading') {
      await queue.remove(l.captureId);
    } else {
      if (!window.confirm('The last capture is already stored on the server. Remove its page(s) from the book? (The photo is kept on the server.)')) return;
      await new Promise((r) => setTimeout(r, 300));
      const { pages } = await api<{ pages: { id: string; capture_id: string }[] }>('GET', `/api/books/${bookId}/pages`);
      for (const p of pages.filter((p) => p.capture_id === l.captureId)) await api('DELETE', `/api/pages/${p.id}`, { confirm: true });
    }
    printed = l.printedBefore;
    nextIndex = Math.max(nextIndex, l.indexBefore + 1); // never reuse an index
    if (printed !== null) localStorage.setItem(nextKey, printed);
    sessionCount = Math.max(0, sessionCount - 1);
    last = null;
    undoBtn.disabled = true;
    renderLabels();
    void renderQueue();
    toast('Last capture removed — retake it', 'ok');
  });
  video.addEventListener('click', async (ev) => {
    const r = video.getBoundingClientRect();
    if (await camera.focusAt((ev.clientX - r.left) / r.width, (ev.clientY - r.top) / r.height)) toast('Focusing…');
  });

  const startCamera = async () => {
    fallback.hidden = true;
    if (!Camera.supported()) return showFallback('This browser does not expose the live camera.');
    try {
      const caps = await camera.start(video);
      torchBtn.hidden = !caps.torch;
      camInfo.textContent = caps.fullResStill
        ? `Full-res photos${caps.stillMaxWidth ? ` up to ${caps.stillMaxWidth}px` : ''}`
        : `Video-frame capture ${caps.videoWidth}×${caps.videoHeight}`;
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

  const requestWake = async () => {
    try { wake = await (navigator as any).wakeLock?.request('screen'); } catch { wake = null; }
  };
  const onVisible = () => {
    if (document.visibilityState === 'visible') { void startCamera(); void requestWake(); } else camera.stop();
  };
  document.addEventListener('visibilitychange', onVisible);
  const onKey = (e: KeyboardEvent) => { if (e.code === 'Space' || e.code === 'AudioVolumeUp' || e.code === 'VolumeUp') { e.preventDefault(); capture(); } };
  window.addEventListener('keydown', onKey);
  const off = onQueueChange(() => void renderQueue());

  mount(root,
    h('div', { class: 'scan' },
      h('div', { class: 'scanbar top' },
        h('button', { class: 'tool', onclick: () => go('/'), 'aria-label': 'Back to dashboard' }, '←'),
        h('div', { class: 'scantitle' }, h('strong', null, book.title), counts),
        pageLabel),
      h('div', { class: 'stage' }, video, guide, flash, fallback),
      h('div', { class: 'scanbar status' }, queueStat, camInfo),
      h('div', { class: 'scanbar bottom' },
        h('div', { class: 'toolcol' }, modeBtn, torchBtn, undoBtn),
        shutter,
        h('div', { class: 'toolcol' }, lastThumb, pauseBtn, retryBtn,
          h('button', { class: 'tool', onclick: () => go(`/books/${bookId}/pages`) }, '✓ Finish'))),
      fileInput));

  renderLabels();
  void renderQueue();
  await startCamera();
  void requestWake();

  return () => {
    camera.stop();
    off();
    document.removeEventListener('visibilitychange', onVisible);
    window.removeEventListener('keydown', onKey);
    try { wake?.release(); } catch { /* ignore */ }
  };
}
