import { api } from '../api';
import { auth } from '../state';
import { h, mount, settings, toast } from '../ui';

export async function settingsView(root: HTMLElement): Promise<void> {
  const maxPending = h('input', { type: 'number', min: 3, max: 200, value: settings.maxPending });
  const maxSide = h('select', null, [2400, 3000, 3600, 4200, 5000].map((v) => h('option', { value: v, selected: v === settings.maxSide }, `${v}px long side`)));
  const quality = h('select', null, [0.85, 0.9, 0.92, 0.95].map((v) => h('option', { value: v, selected: v === settings.quality }, `${Math.round(v * 100)}%`)));
  const theme = h('select', null, ['system', 'light', 'dark'].map((v) => h('option', { value: v, selected: v === settings.theme }, v)));
  let usage = '';
  try {
    const est = await navigator.storage?.estimate?.();
    if (est?.usage != null) usage = `Browser storage used by this site: ${(est.usage / 1e6).toFixed(1)} MB${est.quota ? ` of ${(est.quota / 1e9).toFixed(1)} GB allowed` : ''}.`;
  } catch { /* optional */ }

  mount(root,
    h('header', { class: 'pagehead' }, h('h1', null, 'Settings')),
    h('form', {
      class: 'card narrow', onsubmit: (e: Event) => {
        e.preventDefault();
        settings.maxPending = Math.max(3, Math.min(200, Number(maxPending.value)));
        settings.maxSide = Number(maxSide.value);
        settings.quality = Number(quality.value);
        settings.theme = theme.value;
        toast('Settings saved on this device', 'ok');
      },
    },
    h('label', null, 'Maximum captures waiting on this phone', maxPending),
    h('p', { class: 'muted small' }, 'When this many photos are waiting to upload, capture pauses so the phone never fills up. Photos are kept in app storage (not the gallery) and deleted after the server confirms them.'),
    h('label', null, 'Upload resolution', maxSide),
    h('label', null, 'JPEG quality', quality),
    h('p', { class: 'muted small' }, '3600px at 92% (default) keeps small print legible for OCR at ~1.5–3 MB per photo.'),
    h('label', null, 'Theme', theme),
    h('button', { type: 'submit', class: 'primary' }, 'Save')),
    h('section', { class: 'card narrow' },
      h('p', null, `Signed in as ${auth?.user?.username ?? '?'}.`),
      usage ? h('p', { class: 'muted small' }, usage) : null,
      h('button', { onclick: async () => { await api('POST', '/api/auth/logout'); location.reload(); } }, 'Sign out')));
}
