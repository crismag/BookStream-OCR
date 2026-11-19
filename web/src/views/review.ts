import { api, ApiError } from '../api';
import { processOne } from '../ocr';
import { go } from '../router';
import { badge, h, mount, toast } from '../ui';

interface Bbox { x: number; y: number; w: number; h: number }
interface Region {
  id?: string;
  bbox: Bbox;
  column_id: string;
  reading_order: number;
  lang: string;
  role: string;
  block_type: string;
  source?: string;
  text?: string | null;
  text_source?: string;
  ocr_text?: string | null;
  ocr_version?: number | null;
  ocr_engine?: string | null;
  confidence?: number | null;
  flagged_words?: string[];
  alignment?: { group_id: string; status: string } | null;
}
interface Detail {
  page: { id: string; book_id: string; side: string; printed_page_number: string | null; rotation: number; crop_region: Bbox | null; layout: string | null; effective_layout: string; ocr_status: string; review_status: string; sequence_number: number; prev_page_id: string | null; next_page_id: string | null; updated_at: string };
  book: { id: string; title: string; original_language: string; translation_language: string; default_layout: string };
  regions: Region[];
  ocr_versions: { region_id: string; version: number; engine: string; engine_version: string; confidence: number | null; text: string; created_at: string }[];
}

const ROLES = ['original', 'translation', 'text'];
const TYPES = ['text', 'verse', 'heading', 'footnote', 'header', 'footer', 'page_number', 'caption'];
const LAYOUTS = ['single', 'two_column', 'parallel', 'mixed'];
const COLORS = ['#2563eb', '#dc2626', '#059669', '#d97706', '#7c3aed', '#db2777', '#0891b2', '#65a30d'];

export async function reviewView(root: HTMLElement, pageId: string): Promise<() => void> {
  let d = await api<Detail>('GET', `/api/pages/${pageId}`);
  sessionStorage.setItem('bs.currentBook', d.page.book_id);
  let regions: Region[] = structuredClone(d.regions);
  let dirty = false;
  let selected = new Set<number>();
  let busy = false;

  const stage = h('div', { class: 'reviewstage' });
  const panel = h('div', { class: 'reviewpanel' });

  const reload = async (fresh?: Detail) => {
    d = fresh ?? (await api<Detail>('GET', `/api/pages/${pageId}`));
    regions = structuredClone(d.regions);
    dirty = false;
    selected = new Set();
    draw();
  };

  const saveRegions = async (): Promise<boolean> => {
    const removedWithText = d.regions.filter((r) => r.text && !regions.find((x) => x.id === r.id));
    if (removedWithText.length && !confirm(`${removedWithText.length} removed region(s) have text. Delete them and their OCR/corrections?`)) return false;
    const fresh = await api<Detail>('PUT', `/api/pages/${pageId}/regions`, {
      regions: regions.map((r, i) => ({ id: r.id, bbox: r.bbox, column_id: r.column_id, reading_order: r.reading_order || i + 1, lang: r.lang, role: r.role, block_type: r.block_type })),
      delete_missing: true,
    });
    await reload(fresh);
    toast('Regions saved', 'ok');
    return true;
  };

  const guardDirty = async (): Promise<boolean> => !dirty || (confirm('Save region changes first?') ? saveRegions() : (dirty = false, true));

  const drawStage = () => {
    const img = h('img', { src: `/api/pages/${pageId}/image?variant=view&v=${encodeURIComponent(d.page.updated_at)}`, alt: 'Scanned page', draggable: 'false' });
    const layer = h('div', { class: 'regionlayer' });
    regions.forEach((r, i) => {
      const color = COLORS[i % COLORS.length];
      const box = h('div', {
        class: `rbox${selected.has(i) ? ' sel' : ''}`,
        style: { left: `${r.bbox.x * 100}%`, top: `${r.bbox.y * 100}%`, width: `${r.bbox.w * 100}%`, height: `${r.bbox.h * 100}%`, borderColor: color },
      }, h('span', { class: 'rlabel', style: { background: color } }, `${i + 1} ${r.lang}${r.role !== 'text' ? ' ' + r.role[0].toUpperCase() : ''}`), h('span', { class: 'rhandle', style: { background: color } }));
      const startDrag = (ev: PointerEvent, resize: boolean) => {
        ev.preventDefault();
        ev.stopPropagation();
        const rect = layer.getBoundingClientRect();
        const sx = ev.clientX, sy = ev.clientY;
        const b0 = { ...r.bbox };
        box.setPointerCapture(ev.pointerId);
        const mv = (e: PointerEvent) => {
          const dx = (e.clientX - sx) / rect.width, dy = (e.clientY - sy) / rect.height;
          if (resize) {
            r.bbox.w = clamp(b0.w + dx, 0.02, 1 - b0.x);
            r.bbox.h = clamp(b0.h + dy, 0.02, 1 - b0.y);
          } else {
            r.bbox.x = clamp(b0.x + dx, 0, 1 - b0.w);
            r.bbox.y = clamp(b0.y + dy, 0, 1 - b0.h);
          }
          Object.assign(box.style, { left: `${r.bbox.x * 100}%`, top: `${r.bbox.y * 100}%`, width: `${r.bbox.w * 100}%`, height: `${r.bbox.h * 100}%` });
          dirty = true;
        };
        const up = () => { box.removeEventListener('pointermove', mv); box.removeEventListener('pointerup', up); drawPanel(); };
        box.addEventListener('pointermove', mv);
        box.addEventListener('pointerup', up);
      };
      box.addEventListener('pointerdown', (e) => startDrag(e, (e.target as HTMLElement).classList.contains('rhandle')));
      layer.appendChild(box);
    });
    mount(stage, h('div', { class: 'imgwrap' }, img, layer));
  };

  const regionCard = (r: Region, i: number) => {
    const color = COLORS[i % COLORS.length];
    const text = h('textarea', { rows: Math.min(18, Math.max(4, (r.text ?? '').split('\n').length + 1)), value: r.text ?? '', lang: r.lang, spellcheck: 'false', 'aria-label': `Text of region ${i + 1}` });
    const sel = (opts: string[], val: string, on: (v: string) => void) => h('select', { onchange: (e: Event) => { on((e.target as HTMLSelectElement).value); dirty = true; drawStage(); drawPanel(); } }, opts.map((o) => h('option', { value: o, selected: o === val }, o)));
    const versions = d.ocr_versions.filter((v) => v.region_id === r.id);
    return h('section', { class: 'rcard', style: { borderLeftColor: color } },
      h('div', { class: 'rhead' },
        h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: selected.has(i), onchange: (e: Event) => { (e.target as HTMLInputElement).checked ? selected.add(i) : selected.delete(i); drawStage(); } }), ` Region ${i + 1}`),
        sel(ROLES, r.role, (v) => (r.role = v)),
        h('input', { class: 'lang', value: r.lang, size: 4, 'aria-label': 'Language code', onchange: (e: Event) => { r.lang = (e.target as HTMLInputElement).value.trim().toLowerCase(); dirty = true; drawStage(); } }),
        sel(TYPES, r.block_type, (v) => (r.block_type = v)),
        h('input', { class: 'order', type: 'number', value: r.reading_order, min: 1, 'aria-label': 'Reading order', onchange: (e: Event) => { r.reading_order = Number((e.target as HTMLInputElement).value); dirty = true; } }),
        h('button', { class: 'small danger', 'aria-label': 'Remove region', onclick: () => { regions.splice(i, 1); dirty = true; draw(); } }, '✕')),
      h('div', { class: 'rmeta muted small' },
        r.text_source === 'correction' ? badge('corrected') : r.text_source === 'ocr' ? badge('ocr_text') : badge('not_processed'),
        r.confidence != null ? ` conf ${r.confidence}%` : '',
        r.ocr_engine ? ` · ${r.ocr_engine} v${r.ocr_version}` : '',
        r.alignment ? h('span', null, ' · pair ', badge(r.alignment.status)) : r.role !== 'text' && r.id ? ' · unpaired' : ''),
      r.flagged_words?.length ? h('p', { class: 'flagged small' }, '! Uncertain words: ', r.flagged_words.slice(0, 30).join(' · ')) : null,
      r.id ? text : h('p', { class: 'muted small' }, 'Save regions to enable text.'),
      r.id ? h('div', { class: 'actions' },
        h('button', {
          class: 'primary small', onclick: async () => {
            const res = await api<Region>('POST', `/api/regions/${r.id}/correction`, { text: text.value });
            r.text = res.text; r.text_source = res.text_source;
            toast('Correction saved (OCR text kept separately)', 'ok');
            drawPanel();
          },
        }, 'Save text'),
        r.ocr_text != null && r.text_source === 'correction' ? h('button', { class: 'small', onclick: () => { text.value = r.ocr_text ?? ''; } }, 'Restore OCR text') : null,
        versions.length > 1 ? h('details', null, h('summary', null, `Compare ${versions.length} OCR versions`),
          versions.map((v) => h('div', { class: 'ver' }, h('div', { class: 'muted small' }, `v${v.version} · ${v.engine} ${v.engine_version} · ${v.confidence ?? '?'}% · ${new Date(v.created_at).toLocaleString()}`), h('pre', null, v.text)))) : null) : null);
  };

  const drawPanel = () => {
    const p = d.page;
    const layoutSel = h('select', null, LAYOUTS.map((l) => h('option', { value: l, selected: l === p.effective_layout }, l)));
    const split = p.side !== 'full' ? h('input', {
      type: 'range', min: 30, max: 70, step: 0.5,
      value: p.crop_region ? (p.side === 'left' ? p.crop_region.w : p.crop_region.x) * 100 : 50,
      onchange: async (e: Event) => {
        const s = Number((e.target as HTMLInputElement).value) / 100;
        const crop = p.side === 'left' ? { x: 0, y: 0, w: s, h: 1 } : { x: s, y: 0, w: 1 - s, h: 1 };
        await reload(await api<Detail>('PATCH', `/api/pages/${pageId}`, { crop_region: crop }));
      },
    }) : null;
    const pairs = new Map<string, number[]>();
    regions.forEach((r, i) => { if (r.alignment) pairs.set(r.alignment.group_id, [...(pairs.get(r.alignment.group_id) ?? []), i]); });

    mount(panel,
      h('div', { class: 'reviewhead' },
        h('button', { class: 'small', disabled: !p.prev_page_id, onclick: async () => { if (await guardDirty()) go(`/pages/${p.prev_page_id}/review`); } }, '← Prev'),
        h('strong', null, `${p.printed_page_number ? 'p. ' + p.printed_page_number : 'Unnumbered'} (#${p.sequence_number}${p.side !== 'full' ? ' ' + p.side : ''})`),
        h('button', { class: 'small', disabled: !p.next_page_id, onclick: async () => { if (await guardDirty()) go(`/pages/${p.next_page_id}/review`); } }, 'Next →')),
      h('div', { class: 'statusrow' }, badge(p.ocr_status), ' ', badge(p.review_status)),
      h('div', { class: 'actions' },
        h('button', {
          class: 'primary', disabled: busy, onclick: async () => {
            if (!(await guardDirty())) return;
            busy = true; drawPanel();
            try {
              await api('POST', `/api/books/${p.book_id}/ocr/enqueue`, { page_ids: [pageId], force: true });
              for (let n = 0; n < 10; n++) {
                const job = await processOne(p.book_id, (s) => toast(s), () => false);
                if (!job || job.page_id === pageId) break;
              }
              await reload();
            } catch (e) { toast((e as Error).message, 'error'); }
            busy = false; drawPanel();
          },
        }, busy ? 'Running OCR…' : '⚙ OCR this page now'),
        h('button', { onclick: async () => { await api('PATCH', `/api/pages/${pageId}`, { review_status: 'reviewed' }); toast('Marked reviewed', 'ok'); if (p.next_page_id) go(`/pages/${p.next_page_id}/review`); else void reload(); } }, '✔ Mark reviewed'),
        p.review_status === 'reviewed' ? h('button', { onclick: async () => { await reload(await api<Detail>('PATCH', `/api/pages/${pageId}`, { review_status: 'needs_review' })); } }, 'Reopen') : null),
      h('details', { class: 'tools', open: false },
        h('summary', null, 'Page tools: layout, rotation, split, number'),
        h('div', { class: 'actions' },
          h('button', { class: 'small', onclick: async () => reload(await api<Detail>('PATCH', `/api/pages/${pageId}`, { rotation: p.rotation - 90 })) }, '⟲ Rotate'),
          h('button', { class: 'small', onclick: async () => reload(await api<Detail>('PATCH', `/api/pages/${pageId}`, { rotation: p.rotation + 90 })) }, '⟳ Rotate'),
          h('button', {
            class: 'small', onclick: async () => {
              const v = prompt('Printed page number (empty = unnumbered)', p.printed_page_number ?? '');
              if (v !== null) await reload(await api<Detail>('PATCH', `/api/pages/${pageId}`, { printed_page_number: v.trim() || null }));
            },
          }, '# Page number'),
          h('a', { class: 'button small', href: `/api/pages/${pageId}/image?variant=original`, target: '_blank', rel: 'noopener' }, 'Original photo')),
        split ? h('label', null, `Spread split position (${p.side} page)`, split) : null,
        h('label', null, 'Layout for this page', layoutSel),
        h('button', {
          class: 'small', onclick: async () => {
            const hasText = regions.some((r) => r.text);
            if (hasText && !confirm('Replace all regions with the preset? Existing OCR text and corrections on this page will be deleted.')) return;
            try {
              await reload(await api<Detail>('POST', `/api/pages/${pageId}/regions/preset`, { layout: layoutSel.value, force: hasText }));
            } catch (e) { toast((e as ApiError).message, 'error'); }
          },
        }, 'Apply layout preset')),
      h('div', { class: 'actions' },
        h('button', { class: 'small', onclick: () => { regions.push({ bbox: { x: 0.1, y: 0.1, w: 0.35, h: 0.2 }, column_id: 'main', reading_order: regions.length + 1, lang: d.book.original_language, role: 'text', block_type: 'text' }); dirty = true; draw(); } }, '+ Region'),
        h('button', { class: dirty ? 'small primary' : 'small', disabled: !dirty, onclick: () => void saveRegions() }, dirty ? 'Save regions*' : 'Regions saved'),
        h('button', { class: 'small', disabled: dirty, onclick: async () => reload(await api<Detail>('POST', `/api/pages/${pageId}/alignment/infer`, {})) }, '≈ Infer pairs'),
        h('button', {
          class: 'small', disabled: dirty || selected.size < 2, onclick: async () => {
            const groups = [...pairs.entries()].map(([, idx]) => idx.filter((i) => !selected.has(i))).filter((g) => g.length >= 2)
              .map((g) => ({ region_ids: g.map((i) => regions[i].id), status: regions[g[0]].alignment?.status ?? 'verified' }));
            groups.push({ region_ids: [...selected].map((i) => regions[i].id), status: 'verified' });
            await reload(await api<Detail>('PUT', `/api/pages/${pageId}/alignment`, { groups }));
          },
        }, '⛓ Pair selected'),
        h('button', {
          class: 'small', disabled: dirty || pairs.size === 0, onclick: async () => {
            const groups = [...pairs.values()].map((idx) => idx.filter((i) => !selected.has(i))).filter((g) => g.length >= 2)
              .map((g) => ({ region_ids: g.map((i) => regions[i].id), status: selected.size ? regions[g[0]].alignment?.status : 'verified' }));
            await reload(await api<Detail>('PUT', `/api/pages/${pageId}/alignment`, { groups }));
          },
        }, selected.size ? 'Unpair selected' : '✔ Verify all pairs')),
      h('p', { class: 'muted small' }, 'Drag boxes to move, drag the corner square to resize. Check two or more regions to pair an original with its translation (1:1, 1:n or n:1).'),
      regions.map(regionCard));
  };

  const draw = () => { drawStage(); drawPanel(); };
  mount(root, h('div', { class: 'review' }, stage, panel));
  draw();

  const beforeUnload = (e: BeforeUnloadEvent) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } };
  window.addEventListener('beforeunload', beforeUnload);
  return () => window.removeEventListener('beforeunload', beforeUnload);
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
