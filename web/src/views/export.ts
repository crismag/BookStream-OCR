import { api } from '../api';
import type { Book } from '../state';
import { h, mount } from '../ui';

export async function exportView(root: HTMLElement, bookId: string): Promise<void> {
  sessionStorage.setItem('bs.currentBook', bookId);
  const { book } = await api<{ book: Book }>('GET', `/api/books/${bookId}`);
  const exHeaders = h('input', { type: 'checkbox', checked: true });
  const exNumbers = h('input', { type: 'checkbox', checked: true });
  const exFoot = h('input', { type: 'checkbox', checked: false });
  const from = h('input', { type: 'number', min: 1, placeholder: 'first', inputmode: 'numeric' });
  const to = h('input', { type: 'number', min: 1, placeholder: 'last', inputmode: 'numeric' });
  const preview = h('pre', { class: 'preview-text', 'aria-label': 'Export preview' });

  const qs = (extra: Record<string, string>) => {
    const exclude = [exHeaders.checked ? 'header,footer' : '', exNumbers.checked ? 'page_number' : '', exFoot.checked ? 'footnote' : ''].filter(Boolean).join(',');
    const p = new URLSearchParams({ ...extra });
    if (exclude) p.set('exclude', exclude);
    if (from.value) p.set('from', from.value);
    if (to.value) p.set('to', to.value);
    return p.toString();
  };
  const link = (label: string, path: string, extra: Record<string, string>, hint: string) =>
    h('div', { class: 'exportrow' },
      h('div', null, h('strong', null, label), h('div', { class: 'muted small' }, hint)),
      h('div', { class: 'actions' },
        h('button', { class: 'small', onclick: async () => {
          const r = await fetch(`/api/books/${bookId}/${path}?${qs({ ...extra, download: '0' })}`, { credentials: 'same-origin' });
          const t = await r.text();
          preview.textContent = t.length > 20000 ? t.slice(0, 20000) + '\n… (preview truncated)' : t;
        } }, 'Preview'),
        h('a', { class: 'button small primary', href: '#', onclick: (e: Event) => { (e.currentTarget as HTMLAnchorElement).href = `/api/books/${bookId}/${path}?${qs(extra)}`; } }, 'Download')));

  const orig = book.original_language, tr = book.translation_language;
  mount(root,
    h('header', { class: 'pagehead' }, h('h1', null, `Export — ${book.title}`)),
    h('section', { class: 'card' },
      h('p', { class: 'muted' }, 'Exports are built from the structured pages: human corrections where present, otherwise the unmodified OCR text. Missing pages and unprocessed regions are marked, never hidden.'),
      h('fieldset', null, h('legend', null, 'Leave out'),
        h('label', { class: 'chk' }, exHeaders, ' running headers/footers'),
        h('label', { class: 'chk' }, exNumbers, ' printed page numbers'),
        h('label', { class: 'chk' }, exFoot, ' footnotes')),
      h('div', { class: 'row2' }, h('label', null, 'From page # (sequence)', from), h('label', null, 'To page #', to)),
      link('Full text (TXT)', 'export.txt', { mode: 'full' }, 'Every region in reading order, labelled by column and language.'),
      link(`Original only — ${orig} (TXT)`, 'export.txt', { mode: 'original' }, 'Only regions in the original language.'),
      link(`Translation only — ${tr} (TXT)`, 'export.txt', { mode: 'translation' }, 'Only regions in the translation language.'),
      link('Parallel bilingual (TXT)', 'export.txt', { mode: 'parallel' }, 'Aligned pairs (inferred or verified) followed by unpaired text.'),
      link('Parallel table (TSV)', 'export.txt', { mode: 'parallel', format: 'tsv' }, 'One row per pair: page, status, original, translation. Opens in Sheets/Excel.'),
      link('Structured data (JSON)', 'export.json', {}, 'Schema bookstream.book.v1: regions, boxes, all OCR versions, corrections, alignments, provenance.')),
    h('section', { class: 'card' }, h('h2', null, 'Preview'), preview));
}
