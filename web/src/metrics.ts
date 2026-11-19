/**
 * Lightweight client-side timing samples (ms). Kept per stage, last 300 samples,
 * persisted in localStorage so diagnostics survive reloads. Exposed on
 * window.__bsMetrics for automated benchmarks.
 */
const KEY = 'bs.metrics.v1';
const MAX = 300;
type Store = Record<string, number[]>;

let store: Store = {};
try { store = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Store; } catch { store = {}; }
let saveTimer: ReturnType<typeof setTimeout> | null = null;

export function record(stage: string, ms: number): void {
  if (!Number.isFinite(ms) || ms < 0) return;
  (store[stage] ??= []).push(Math.round(ms * 10) / 10);
  if (store[stage].length > MAX) store[stage].splice(0, store[stage].length - MAX);
  if (!saveTimer) saveTimer = setTimeout(() => { saveTimer = null; try { localStorage.setItem(KEY, JSON.stringify(store)); } catch { /* quota */ } }, 1000);
}

export function percentile(v: number[], q: number): number | null {
  if (!v.length) return null;
  const s = [...v].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.round(q * (s.length - 1)))];
}

export function summary(): Record<string, { n: number; p50: number | null; p95: number | null }> {
  const out: Record<string, { n: number; p50: number | null; p95: number | null }> = {};
  for (const [k, v] of Object.entries(store)) out[k] = { n: v.length, p50: percentile(v, 0.5), p95: percentile(v, 0.95) };
  return out;
}

export function reset(): void {
  store = {};
  try { localStorage.removeItem(KEY); } catch { /* ignore */ }
}

export function heapMB(): number | null {
  const m = (performance as any).memory;
  return m?.usedJSHeapSize ? Math.round(m.usedJSHeapSize / 1e6) : null;
}

(globalThis as any).__bsMetrics = { summary, reset, store: () => store };
