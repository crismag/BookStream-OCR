import { api } from '../api';
import { go } from '../router';
import { onQueueChange, queue, uploader, type Book } from '../state';
import { badge, fmtBytes, h, mount, toast } from '../ui';

interface PageRow {
  id: string;
  capture_id: string;
  side: string;
  printed_page_number: string | null;
  sequence_number: number;
  ocr_status: string;
  review_status: string;
  layout: string | null;
  updated_at: string;
}
interface Integrity { missing: number[]; duplicates: string[]; numbered: number; unnumbered: number }

export async function pagesView(root: HTMLElement, bookId: string): Promise<() => void> {
  sessionStorage.setItem('bs.currentBook', bookId);
  const pendingBox = h('section', { class: 'card' });

  const renderPending = async () => {
    const items = await queue.all(bookId);
    if (!items.length) { mount(pendingBox, h('p', null, badge('confirmed'), ' Every capture from this phone is stored on the server.')); return; }
    mount(pendingBox,
      h('h2', null, `On this phone, not yet confirmed (${items.length})`),
      h('ul', { class: 'pending' }, items.map((i) => h('li', null,
        badge(i.status), ` #${i.captureIndex} · page ${i.printedPageNumber ?? '—'} · ${i.mode} · ${fmtBytes(i.size)}`,
        i.lastError ? h('span', { class: 'muted small' }, ` — ${i.lastError}`) : null,
        i.status === 'blocked' ? h('button', {
          class: 'small danger', onclick: async () => {
            if (!confirm('Discard this capture? It was NOT stored on the server and will be lost.')) return;
            await queue.remove(i.captureId);
            void renderPending();
          },
        }, 'Discard…') : null))),
      h('button', { onclick: () => void uploader.retryNow() }, '↻ Retry all now'));
  };

  const render = async () => {
    const [{ book }, { pages, integrity }] = await Promise.all([
      api<{ book: Book }>('GET', `/api/books/${bookId}`),
      api<{ pages: PageRow[]; integrity: Integrity }>('GET', `/api/books/${bookId}/pages`),
    ]);
    const move = async (idx: number, delta: number) => {
      const ids = pages.map((p) => p.id);
      const j = idx + delta;
      if (j < 0 || j >= ids.length) return;
      [ids[idx], ids[j]] = [ids[j], ids[idx]];
      await api('POST', `/api/books/${bookId}/pages/reorder`, { page_ids: ids });
      void render();
    };
    const tile = (p: PageRow, idx: number) => h('li', { class: 'tile' },
      h('a', { href: `#/pages/${p.id}/review`, class: 'thumb' },
        h('img', { src: `/api/pages/${p.id}/image?variant=thumb&v=${encodeURIComponent(p.updated_at)}`, loading: 'lazy', alt: `Page ${p.printed_page_number ?? 'unnumbered'}` })),
      h('div', { class: 'tilemeta' },
        h('strong', null, p.printed_page_number ? `p. ${p.printed_page_number}` : 'unnumbered'),
        h('span', { class: 'muted small' }, ` #${p.sequence_number}${p.side !== 'full' ? ` · ${p.side}` : ''}`),
        h('div', null, badge(p.ocr_status)),
        h('div', null, badge(p.review_status))),
      h('div', { class: 'tileactions' },
        h('button', { class: 'small', 'aria-label': 'Move earlier', onclick: () => move(idx, -1) }, '↑'),
        h('button', { class: 'small', 'aria-label': 'Move later', onclick: () => move(idx, 1) }, '↓'),
        h('button', {
          class: 'small', onclick: async () => {
            const v = prompt('Printed page number (empty = unnumbered)', p.printed_page_number ?? '');
            if (v === null) return;
            await api('PATCH', `/api/pages/${p.id}`, { printed_page_number: v.trim() || null });
            void render();
          },
        }, '#')));

    const toOcr = pages.filter((p) => p.ocr_status === 'not_processed' || p.ocr_status === 'failed').length;
    mount(root,
      h('header', { class: 'pagehead' },
        h('h1', null, book.title),
        h('div', { class: 'actions' },
          h('button', { class: 'primary', onclick: () => go(`/books/${bookId}/scan`) }, '◉ Scan more'),
          h('button', {
            disabled: toOcr === 0, onclick: async () => {
              const r = await api<{ enqueued: number }>('POST', `/api/books/${bookId}/ocr/enqueue`, {});
              toast(`${r.enqueued} page(s) queued for OCR. Open Process on a laptop to run them.`, 'ok');
              void render();
            },
          }, `⚙ Queue OCR (${toOcr})`),
          h('button', { onclick: () => go('/process') }, 'Process now'),
          pages.find((p) => p.review_status !== 'reviewed') ? h('button', { onclick: () => go(`/pages/${pages.find((p) => p.review_status !== 'reviewed')!.id}/review`) }, '✎ Review next') : null)),
      pendingBox,
      h('section', { class: 'card integrity' },
        h('h2', null, 'Integrity'),
        h('p', null, `${pages.length} pages stored${book.expected_page_count ? ` of ${book.expected_page_count} expected` : ''} · ${integrity.numbered} numbered · ${integrity.unnumbered} unnumbered`),
        integrity.missing.length ? h('p', { class: 'warn' }, '! Missing printed pages: ', compact(integrity.missing)) : h('p', null, '✓ No gaps in printed page numbers'),
        integrity.duplicates.length ? h('p', { class: 'warn' }, '! Duplicate page numbers: ', integrity.duplicates.join(', ')) : null),
      pages.length ? h('ol', { class: 'tiles' }, pages.map(tile)) : h('p', { class: 'card' }, 'No pages yet.'));
    void renderPending();
  };

  await render();
  const off = onQueueChange(() => void renderPending());
  return () => off();
}

function compact(nums: number[]): string {
  const out: string[] = [];
  for (let i = 0; i < nums.length; i++) {
    let j = i;
    while (j + 1 < nums.length && nums[j + 1] === nums[j] + 1) j++;
    out.push(i === j ? `${nums[i]}` : `${nums[i]}–${nums[j]}`);
    i = j;
  }
  return out.join(', ');
}
