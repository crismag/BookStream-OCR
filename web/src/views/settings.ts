import { api } from '../api';
import { reset, summary } from '../metrics';
import { auth, uploader } from '../state';
import { PRESETS, h, mount, settings, toast, type CropSetting, type PresetKey } from '../ui';

type Stat = { n: number; p50: number | null; p95: number | null };

export async function settingsView(root: HTMLElement): Promise<void> {
  const presetSel = h('select', null, PRESETS.map((p) => h('option', { value: p.key, selected: p.key === settings.preset }, `${p.label} — ${p.maxSide ? p.maxSide + 'px long edge' : 'native camera resolution'}, JPEG ${Math.round(p.quality * 100)}%`)));
  const quality = h('select', null, [['0', 'Preset default'], ['0.75', '75%'], ['0.8', '80%'], ['0.85', '85%'], ['0.9', '90%'], ['0.95', '95%']].map(([v, l]) => h('option', { value: v, selected: Number(v) === settings.qualityOverride }, l)));
  const crop = h('select', null, [['off', 'Off — keep the whole frame'], ['guide', 'Guide box — crop to the dashed page guide (+3% margin)'], ['auto', 'Auto edges — detect page, straighten (Enhanced mode)']].map(([v, l]) => h('option', { value: v, selected: v === settings.crop }, l)));
  const minimal = h('input', { type: 'checkbox', checked: settings.minimal });
  const maxPending = h('input', { type: 'number', min: 3, max: 1000, value: settings.maxPending });
  const conc = h('select', null, ['1', '2', '3', '4'].map((v) => h('option', { value: v, selected: Number(v) === settings.concurrency }, v)));
  const theme = h('select', null, ['system', 'light', 'dark'].map((v) => h('option', { value: v, selected: v === settings.theme }, v)));
  let usage = '';
  try {
    const est = await navigator.storage?.estimate?.();
    if (est?.usage != null) usage = `Browser storage used by this site: ${(est.usage / 1e6).toFixed(1)} MB${est.quota ? ` of ${(est.quota / 1e9).toFixed(1)} GB allowed` : ''}.`;
  } catch { /* optional */ }

  const diag = h('pre', { class: 'preview-text' });
  const renderDiag = async () => {
    const fmt = (k: string, s: Stat | undefined) => (s && s.n ? `${k.padEnd(26)} p50 ${String(s.p50).padStart(8)}  p95 ${String(s.p95).padStart(8)}  n=${s.n}` : null);
    const c = summary();
    const lines = ['— This device —', ...Object.keys(c).sort().map((k) => fmt(k, c[k]))];
    const book = sessionStorage.getItem('bs.currentBook');
    if (book) {
      try {
        const m = await api<Record<string, any>>('GET', `/api/books/${book}/metrics`);
        lines.push('', '— Server (current book, all devices) —',
          fmt('server_ms (upload handling)', m.server_ms), fmt('stored_bytes', m.stored_bytes),
          fmt('ocr_queue_delay_ms', m.ocr_queue_delay_ms), fmt('ocr_job_ms (lease→done)', m.ocr_job_ms), fmt('ocr_region_exec_ms', m.ocr_region_exec_ms),
          ...Object.keys(m.client ?? {}).sort().map((k) => fmt(`client.${k}`, m.client[k])));
      } catch { /* offline */ }
    }
    diag.textContent = lines.filter((l) => l !== null).join('\n');
  };

  mount(root,
    h('header', { class: 'pagehead' }, h('h1', null, 'Settings')),
    h('form', {
      class: 'card narrow', onsubmit: (e: Event) => {
        e.preventDefault();
        settings.preset = presetSel.value as PresetKey;
        settings.qualityOverride = Number(quality.value);
        settings.crop = crop.value as CropSetting;
        settings.minimal = minimal.checked;
        settings.maxPending = Math.max(3, Math.min(1000, Number(maxPending.value)));
        settings.concurrency = Number(conc.value);
        uploader.setConcurrency(settings.concurrency);
        settings.theme = theme.value;
        toast('Settings saved on this device', 'ok');
      },
    },
    h('h2', null, 'Capture'),
    h('label', null, 'Resolution preset', presetSel),
    h('p', { class: 'muted small' }, 'The preset sets the saved image size. Minimal uses the live preview frame (instant); larger presets take a still photo at the nearest size the camera supports and shrink it — never enlarge. A camera JPEG that already fits is stored untouched.'),
    h('label', null, 'JPEG quality', quality),
    h('label', null, 'Cropping', crop),
    h('label', { class: 'chk' }, minimal, ' Minimal mode (no live page detection, fewer screen updates — lowest load)'),
    h('h2', null, 'Uploads'),
    h('label', null, 'Maximum photos waiting on this phone', maxPending),
    h('label', null, 'Parallel uploads (drops to 1 automatically on a weak connection)', conc),
    h('label', null, 'Theme', theme),
    h('button', { type: 'submit', class: 'primary' }, 'Save')),
    h('section', { class: 'card narrow' },
      h('h2', null, 'Diagnostics'),
      h('p', { class: 'muted small' }, 'Measured timings in milliseconds (p50 = typical, p95 = slow cases). Use these to compare presets on your phone.'),
      h('div', { class: 'actions' }, h('button', { class: 'small', onclick: () => void renderDiag() }, 'Refresh'), h('button', { class: 'small', onclick: () => { reset(); void renderDiag(); } }, 'Clear this device’s samples')),
      diag),
    h('section', { class: 'card narrow' },
      h('p', null, `Signed in as ${auth?.user?.username ?? '?'}.`),
      usage ? h('p', { class: 'muted small' }, usage) : null,
      h('button', { onclick: async () => { await api('POST', '/api/auth/logout'); location.reload(); } }, 'Sign out')));
  void renderDiag();
}
