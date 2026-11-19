type Child = Node | string | number | null | undefined | false | Child[];
type Attrs = Record<string, any> | null;

/** Tiny DOM builder. Text is always inserted as text nodes (no innerHTML → no XSS). */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'class') el.className = String(v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'value' && 'value' in el) (el as any).value = v;
    else if (k === 'checked' || k === 'disabled' || k === 'selected') (el as any)[k] = !!v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  append(el, children);
  return el;
}

function append(el: Node, children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function mount(root: HTMLElement, ...children: Child[]): void {
  root.replaceChildren();
  append(root, children);
}

let toastTimer: ReturnType<typeof setTimeout> | null = null;
export function toast(msg: string, kind: 'ok' | 'error' | 'info' = 'info'): void {
  let t = document.getElementById('toast');
  if (!t) {
    t = h('div', { id: 'toast', role: 'status', 'aria-live': 'polite' });
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.className = `toast show ${kind}`;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t!.classList.remove('show'), kind === 'error' ? 6000 : 2500);
}

/** Status badge: icon + text, never color alone. */
export function badge(status: string): HTMLElement {
  const map: Record<string, [string, string]> = {
    not_processed: ['○', 'Not processed'], queued: ['⧗', 'Queued'], processing: ['⟳', 'Processing'],
    ocr_complete: ['✓', 'OCR complete'], needs_review: ['!', 'Needs review'], failed: ['✕', 'Failed'],
    reviewed: ['✔', 'Reviewed'], not_reviewed: ['·', 'Not reviewed'],
    pending: ['⧗', 'Pending'], uploading: ['↑', 'Uploading'], retrying: ['↻', 'Retrying'], blocked: ['✕', 'Needs attention'],
    confirmed: ['✓', 'Stored'], corrected: ['✎', 'Corrected'], ocr_text: ['⌨', 'Raw OCR'], inferred: ['≈', 'Inferred'], verified: ['✔', 'Verified'],
  };
  const [icon, label] = map[status] ?? ['·', status];
  return h('span', { class: `badge b-${status}` }, h('span', { 'aria-hidden': 'true' }, icon), ' ', label);
}

export function fmtBytes(n: number): string {
  return n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.round(n / 1e3)} kB`;
}

export function confirmTyped(message: string, expected: string): boolean {
  const v = window.prompt(`${message}\n\nType exactly: ${expected}`);
  return v === expected;
}

export const settings = {
  get maxPending(): number { return Number(localStorage.getItem('bs.maxPending') ?? 300); },
  set maxPending(v: number) { localStorage.setItem('bs.maxPending', String(v)); },
  get maxSide(): number { return Number(localStorage.getItem('bs.maxSide') ?? 3000); },
  set maxSide(v: number) { localStorage.setItem('bs.maxSide', String(v)); },
  get quality(): number { return Number(localStorage.getItem('bs.quality') ?? 0.9); },
  set quality(v: number) { localStorage.setItem('bs.quality', String(v)); },
  get autoCrop(): boolean { return localStorage.getItem('bs.autoCrop') !== '0'; },
  set autoCrop(v: boolean) { localStorage.setItem('bs.autoCrop', v ? '1' : '0'); },
  get theme(): string { return localStorage.getItem('bs.theme') ?? 'system'; },
  set theme(v: string) { localStorage.setItem('bs.theme', v); applyTheme(); },
};

/** Capture presets shown on the scan screen. */
export const QUALITY_PRESETS: { key: string; label: string; maxSide: number; quality: number }[] = [
  { key: 'fast', label: 'Fast', maxSide: 2400, quality: 0.88 },
  { key: 'balanced', label: 'Balanced', maxSide: 3000, quality: 0.9 },
  { key: 'max', label: 'Max', maxSide: 4000, quality: 0.92 },
  { key: 'full', label: 'Full sensor', maxSide: 9000, quality: 0.94 },
];

export function currentPreset(): (typeof QUALITY_PRESETS)[number] | null {
  return QUALITY_PRESETS.find((p) => p.maxSide === settings.maxSide && p.quality === settings.quality) ?? null;
}

export function applyTheme(): void {
  const t = settings.theme;
  document.documentElement.dataset.theme = t === 'system' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : t;
}
