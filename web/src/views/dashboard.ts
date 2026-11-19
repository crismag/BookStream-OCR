import { api } from '../api';
import { go } from '../router';
import type { Book } from '../state';
import { confirmTyped, h, mount, toast } from '../ui';

export async function dashboardView(root: HTMLElement): Promise<void> {
  const showArchived = sessionStorage.getItem('bs.showArchived') === '1';
  const { books } = await api<{ books: Book[] }>('GET', `/api/books${showArchived ? '?archived=1' : ''}`);

  const card = (b: Book) => {
    const s = b.stats;
    const expected = b.expected_page_count ?? '?';
    const pct = (n: number) => (s.pages ? Math.round((n / s.pages) * 100) : 0);
    const open = (p: string) => () => { sessionStorage.setItem('bs.currentBook', b.id); go(p); };
    return h('article', { class: 'card book' },
      h('h2', null, b.title),
      b.author ? h('p', { class: 'muted' }, b.author) : null,
      h('dl', { class: 'stats' },
        h('div', null, h('dt', null, 'Pages'), h('dd', null, `${s.pages} / ${expected}`)),
        h('div', null, h('dt', null, 'Captures'), h('dd', null, String(s.captures))),
        h('div', null, h('dt', null, 'Missing'), h('dd', null, String(s.missing_count))),
        h('div', null, h('dt', null, 'OCR'), h('dd', null, `${pct(s.ocr_done)}%${s.ocr_failed ? ` (${s.ocr_failed} failed)` : ''}`)),
        h('div', null, h('dt', null, 'Reviewed'), h('dd', null, `${pct(s.reviewed)}%`)),
        h('div', null, h('dt', null, 'Layout'), h('dd', null, b.default_layout)),
      ),
      h('p', { class: 'muted small' }, `Last activity ${new Date(b.last_activity).toLocaleString()}`),
      h('div', { class: 'actions' },
        h('button', { class: 'primary', onclick: open(`/books/${b.id}/scan`) }, s.pages ? '◉ Resume scanning' : '◉ Start scanning'),
        h('button', { onclick: open(`/books/${b.id}/pages`) }, '▦ Pages'),
        h('button', { onclick: open(`/books/${b.id}/export`) }, '⇩ Export'),
        h('button', { onclick: open(`/books/${b.id}/edit`) }, '✎ Edit'),
        h('button', {
          onclick: async () => {
            await api('POST', `/api/books/${b.id}/archive`, { archived: !b.archived });
            toast(b.archived ? 'Restored' : 'Archived', 'ok');
            void dashboardView(root);
          },
        }, b.archived ? 'Unarchive' : 'Archive'),
      ));
  };

  mount(root,
    h('header', { class: 'pagehead' },
      h('h1', null, showArchived ? 'Archived books' : 'Your books'),
      h('div', { class: 'actions' },
        h('button', { class: 'primary', onclick: () => go('/books/new') }, '+ New book'),
        h('button', { onclick: () => { sessionStorage.setItem('bs.showArchived', showArchived ? '0' : '1'); void dashboardView(root); } }, showArchived ? 'Show active' : 'Show archived'))),
    books.length ? h('div', { class: 'grid' }, books.map(card)) : h('div', { class: 'card' }, h('p', null, showArchived ? 'No archived books.' : 'No books yet. Create one to start scanning.')));
}

const LAYOUTS: [string, string][] = [
  ['single', 'Single column'],
  ['two_column', 'Two independent columns (read left, then right)'],
  ['parallel', 'Parallel translation (left = original, right = translation)'],
  ['mixed', 'Mixed / custom (draw regions per page)'],
];

export async function bookFormView(root: HTMLElement, id: string | null): Promise<void> {
  const book = id ? (await api<{ book: Book }>('GET', `/api/books/${id}`)).book : null;
  const f = {
    title: h('input', { required: true, maxlength: 500, value: book?.title ?? '' }),
    author: h('input', { maxlength: 500, value: book?.author ?? '' }),
    description: h('textarea', { rows: 3, value: book?.description ?? '' }),
    expected: h('input', { type: 'number', min: 0, inputmode: 'numeric', value: book?.expected_page_count ?? '' }),
    orig: h('input', { required: true, pattern: '[a-z]{2,3}', value: book?.original_language ?? 'eng', 'aria-describedby': 'langhelp' }),
    trans: h('input', { required: true, pattern: '[a-z]{2,3}', value: book?.translation_language ?? 'eng' }),
    layout: h('select', null, LAYOUTS.map(([v, l]) => h('option', { value: v, selected: (book?.default_layout ?? 'single') === v }, l))),
  };
  const err = h('p', { class: 'form-error', role: 'alert' });
  const form = h('form', {
    class: 'card narrow',
    onsubmit: async (ev: Event) => {
      ev.preventDefault();
      const body = {
        title: f.title.value, author: f.author.value, description: f.description.value,
        expected_page_count: f.expected.value === '' ? null : Number(f.expected.value),
        original_language: f.orig.value.trim().toLowerCase(), translation_language: f.trans.value.trim().toLowerCase(),
        languages: [...new Set([f.orig.value.trim().toLowerCase(), f.trans.value.trim().toLowerCase()])],
        default_layout: f.layout.value,
      };
      try {
        const r = await api<{ book: Book }>(book ? 'PATCH' : 'POST', book ? `/api/books/${book.id}` : '/api/books', body);
        sessionStorage.setItem('bs.currentBook', r.book.id);
        toast('Saved', 'ok');
        go(book ? '/' : `/books/${r.book.id}/scan`);
      } catch (e) {
        err.textContent = (e as Error).message;
      }
    },
  },
  h('h1', null, book ? 'Edit book' : 'New book'),
  h('label', null, 'Title', f.title),
  h('label', null, 'Author / editor', f.author),
  h('label', null, 'Description', f.description),
  h('label', null, 'Expected page count', f.expected),
  h('div', { class: 'row2' }, h('label', null, 'Original language code', f.orig), h('label', null, 'Translation language code', f.trans)),
  h('p', { id: 'langhelp', class: 'muted small' }, 'ISO 639-3 codes, e.g. mrw = Maranao, eng = English, tgl = Tagalog. Languages without an OCR model use the Latin model with dictionaries off, so spelling is kept as printed.'),
  h('label', null, 'Default page layout', f.layout),
  err,
  h('div', { class: 'actions' },
    h('button', { type: 'submit', class: 'primary' }, book ? 'Save' : 'Create & start scanning'),
    h('button', { type: 'button', onclick: () => go('/') }, 'Cancel'),
    book ? h('button', {
      type: 'button', class: 'danger',
      onclick: async () => {
        if (!confirmTyped(`Delete "${book.title}" and ALL its images and text permanently?`, book.title)) return toast('Deletion cancelled');
        await api('DELETE', `/api/books/${book.id}`, { confirm_title: book.title });
        sessionStorage.removeItem('bs.currentBook');
        toast('Book deleted', 'ok');
        go('/');
      },
    }, 'Delete book…') : null));
  if (!book) {
    form.insertBefore(h('div', { class: 'hint' },
      h('button', {
        type: 'button', onclick: () => {
          f.title.value = 'Darangen — Volume Two'; f.expected.value = '258'; f.orig.value = 'mrw'; f.trans.value = 'eng'; f.layout.value = 'parallel';
        },
      }, 'Fill in: Darangen Vol. 2 (Maranao/English parallel)')), form.children[1]);
  }
  mount(root, form);
}
