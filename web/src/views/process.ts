import { api } from '../api';
import { processOne, terminateAll } from '../ocr';
import type { Book } from '../state';
import { h, mount, toast } from '../ui';

/**
 * OCR worker screen. Runs Tesseract in this browser tab and pulls jobs from the
 * server queue. Best run on a laptop/desktop while the phone keeps scanning.
 */
export async function processView(root: HTMLElement): Promise<() => void> {
  const { books } = await api<{ books: Book[] }>('GET', '/api/books');
  let running = false;
  let stopRequested = false;
  let done = 0;
  let wake: any = null;

  const bookSel = h('select', null, h('option', { value: '' }, 'All books'), books.map((b) => h('option', { value: b.id }, b.title)));
  const current = sessionStorage.getItem('bs.currentBook');
  if (current) bookSel.value = current;
  const status = h('p', { role: 'status', 'aria-live': 'polite' }, 'Idle');
  const log = h('ol', { class: 'log' });
  const counts = h('p', { class: 'muted' });
  const btn = h('button', { class: 'primary big' }, '▶ Start OCR worker');

  const addLog = (s: string) => {
    log.prepend(h('li', null, `${new Date().toLocaleTimeString()} ${s}`));
    while (log.children.length > 200) log.lastChild?.remove();
  };
  const refreshCounts = async () => {
    if (!bookSel.value) { counts.textContent = ''; return; }
    const s = await api<{ queued: number; leased: number; done: number; failed: number }>('GET', `/api/books/${bookSel.value}/ocr/status`);
    counts.textContent = `Queue: ${s.queued} waiting · ${s.leased} in progress · ${s.done} done · ${s.failed} failed`;
  };

  const loop = async () => {
    running = true;
    stopRequested = false;
    btn.textContent = '■ Stop';
    try { wake = await (navigator as any).wakeLock?.request('screen'); } catch { /* optional */ }
    let idleRounds = 0;
    while (!stopRequested) {
      try {
        status.textContent = 'Looking for work…';
        const job = await processOne(bookSel.value || null, (s) => { status.textContent = s; addLog(s); }, () => stopRequested);
        if (job) { done++; idleRounds = 0; void refreshCounts(); continue; }
        idleRounds++;
        status.textContent = `No queued pages. Checking again in ${Math.min(15, 5 * idleRounds)}s… (${done} processed this session)`;
        await sleep(Math.min(15000, 5000 * idleRounds), () => stopRequested);
      } catch (e) {
        addLog(`Error: ${(e as Error).message}`);
        await sleep(10000, () => stopRequested);
      }
    }
    running = false;
    btn.textContent = '▶ Start OCR worker';
    status.textContent = `Stopped. ${done} page(s) processed.`;
    try { wake?.release(); } catch { /* ignore */ }
  };

  btn.addEventListener('click', () => { if (running) stopRequested = true; else void loop(); });
  bookSel.addEventListener('change', () => void refreshCounts());

  const isPhone = matchMedia('(pointer: coarse)').matches && innerWidth < 900;
  mount(root,
    h('header', { class: 'pagehead' }, h('h1', null, 'Process OCR')),
    h('section', { class: 'card' },
      h('p', null, 'Every uploaded page is queued for OCR automatically. Keep this tab open (a laptop is best) and it reads queued pages with Tesseract, entirely in the browser — no cloud service. The scanner shows “worker active” while this runs. Raw OCR is saved per region; nothing is marked reviewed automatically.'),
      isPhone ? h('p', { class: 'warn' }, '! On a phone this uses a lot of battery and slows the camera. Prefer running it on a laptop while you scan.') : null,
      h('label', null, 'Book', bookSel),
      h('div', { class: 'actions' },
        btn,
        h('button', {
          onclick: async () => {
            if (!bookSel.value) return toast('Choose a book first', 'error');
            const r = await api<{ enqueued: number }>('POST', `/api/books/${bookSel.value}/ocr/enqueue`, {});
            toast(`${r.enqueued} page(s) queued`, 'ok');
            void refreshCounts();
          },
        }, 'Queue pages without text')),
      counts, status),
    h('section', { class: 'card' }, h('h2', null, 'Log'), log));
  void refreshCounts();
  return () => { stopRequested = true; void terminateAll(); };
}

function sleep(ms: number, cancel: () => boolean): Promise<void> {
  return new Promise((r) => {
    const t0 = Date.now();
    const tick = () => (cancel() || Date.now() - t0 >= ms ? r() : setTimeout(tick, 250));
    tick();
  });
}
