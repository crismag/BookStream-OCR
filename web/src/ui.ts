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
    not_processed: ['○', 'Stored · no OCR'], queued: ['⧗', 'OCR queued'], processing: ['⟳', 'OCR processing'],
    ocr_complete: ['✓', 'Text saved'], needs_review: ['!', 'Text saved · needs review'], failed: ['✕', 'OCR failed'],
    reviewed: ['✔', 'Reviewed'], not_reviewed: ['·', 'Not reviewed'],
    pending: ['💾', 'Saved locally'], uploading: ['↑', 'Uploading'], retrying: ['↻', 'Retrying'], blocked: ['✕', 'Needs attention'],
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

export type PresetKey = 'minimal' | 'fast' | 'balanced' | 'quality' | 'maximum';
export type CropSetting = 'off' | 'guide' | 'auto';
export type GuideAspect = 'auto' | 'a4' | 'letter' | 'custom';

/** Saved-image presets (target long edge; 0 = native camera resolution, never upscaled). */
export const PRESETS: { key: PresetKey; label: string; maxSide: number; quality: number }[] = [
  { key: 'minimal', label: 'Minimal', maxSide: 1600, quality: 0.8 },
  { key: 'fast', label: 'Fast', maxSide: 2000, quality: 0.82 },
  { key: 'balanced', label: 'Balanced', maxSide: 2400, quality: 0.85 },
  { key: 'quality', label: 'Quality', maxSide: 3000, quality: 0.88 },
  { key: 'maximum', label: 'Maximum', maxSide: 0, quality: 0.92 },
];

const ls = {
  get: (k: string, d: string) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* quota/private mode */ } },
};

// v2 keys: earlier v1 values (bs.maxSide etc.) are intentionally ignored.
export const settings = {
  get preset(): PresetKey { return ls.get('bs2.preset', 'balanced') as PresetKey; },
  set preset(v: PresetKey) { ls.set('bs2.preset', v); },
  /** 0 = use the preset's quality. */
  get qualityOverride(): number { return Number(ls.get('bs2.quality', '0')); },
  set qualityOverride(v: number) { ls.set('bs2.quality', String(v)); },
  get minimal(): boolean { return ls.get('bs2.minimal', '0') === '1'; },
  set minimal(v: boolean) { ls.set('bs2.minimal', v ? '1' : '0'); },
  get crop(): CropSetting { return ls.get('bs2.crop', 'auto') as CropSetting; },
  set crop(v: CropSetting) { ls.set('bs2.crop', v); },
  get guideAspect(): GuideAspect { return ls.get('bs2.guideAspect', 'auto') as GuideAspect; },
  set guideAspect(v: GuideAspect) { ls.set('bs2.guideAspect', v); },
  /** Custom page width/height ratio, e.g. 0.68 for a narrow book. */
  get customRatio(): number { return Number(ls.get('bs2.customRatio', '0.68')); },
  set customRatio(v: number) { ls.set('bs2.customRatio', String(v)); },
  /** Guide size as a fraction of the available frame (adjustable). */
  get guideScale(): number { return Number(ls.get('bs2.guideScale', '0.92')); },
  set guideScale(v: number) { ls.set('bs2.guideScale', String(v)); },
  get maxPending(): number { return Number(ls.get('bs2.maxPending', '300')); },
  set maxPending(v: number) { ls.set('bs2.maxPending', String(v)); },
  get concurrency(): number { return Number(ls.get('bs2.concurrency', '2')); },
  set concurrency(v: number) { ls.set('bs2.concurrency', String(v)); },
  get timer(): number { return Number(ls.get('bs2.timer', '0')); },
  set timer(v: number) { ls.set('bs2.timer', String(v)); },
  get interval(): number { return Number(ls.get('bs2.interval', '6')); },
  set interval(v: number) { ls.set('bs2.interval', String(v)); },
  get localOcr(): boolean { return ls.get('bs2.localOcr', '0') === '1'; },
  set localOcr(v: boolean) { ls.set('bs2.localOcr', v ? '1' : '0'); },
  get theme(): string { return ls.get('bs.theme', 'system'); },
  set theme(v: string) { ls.set('bs.theme', v); applyTheme(); },
};

export function preset(): (typeof PRESETS)[number] {
  return PRESETS.find((p) => p.key === settings.preset) ?? PRESETS[2];
}

export function effectiveQuality(): number {
  return settings.qualityOverride > 0 ? settings.qualityOverride : preset().quality;
}

export function applyTheme(): void {
  const t = settings.theme;
  document.documentElement.dataset.theme = t === 'system' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : t;
}
