import './style.css';
import { ApiError } from './api';
import { auth, onQueueChange, queue, refreshAuth, uploader } from './state';
import { applyTheme, h, mount, toast } from './ui';
import { loginView } from './views/login';
import { dashboardView, bookFormView } from './views/dashboard';
import { scanView } from './views/scan';
import { pagesView } from './views/pages';
import { reviewView } from './views/review';
import { exportView } from './views/export';
import { processView } from './views/process';
import { settingsView } from './views/settings';
import { currentBookId, go } from './router';

export type Cleanup = (() => void) | void;
const app = document.getElementById('app')!;
let cleanup: Cleanup = undefined;

const routes: [RegExp, (root: HTMLElement, ...p: string[]) => Promise<Cleanup> | Cleanup][] = [
  [/^\/$/, dashboardView],
  [/^\/books\/new$/, (r) => bookFormView(r, null)],
  [/^\/books\/([\w-]+)\/edit$/, (r, id) => bookFormView(r, id)],
  [/^\/books\/([\w-]+)\/scan$/, scanView],
  [/^\/books\/([\w-]+)\/pages$/, pagesView],
  [/^\/books\/([\w-]+)\/export$/, exportView],
  [/^\/pages\/([\w-]+)\/review$/, reviewView],
  [/^\/process$/, processView],
  [/^\/settings$/, settingsView],
];


function nav(path: string): HTMLElement {
  const book = currentBookId();
  const items: [string, string, string | null][] = [
    ['Dashboard', '/', '⌂'],
    ['Scan', book ? `/books/${book}/scan` : '/', '◉'],
    ['Pages', book ? `/books/${book}/pages` : '/', '▦'],
    ['Process', '/process', '⚙'],
    ['Export', book ? `/books/${book}/export` : '/', '⇩'],
    ['Settings', '/settings', '☰'],
  ];
  const net = h('span', { class: 'net', id: 'net' });
  const updateNet = async () => {
    const n = await queue.count();
    net.textContent = `${navigator.onLine ? '● Online' : '○ Offline'}${n ? ` · ${n} pending` : ''}`;
    net.classList.toggle('offline', !navigator.onLine);
  };
  void updateNet();
  return h('nav', { class: 'topnav' },
    h('div', { class: 'navlinks' }, items.map(([label, href, icon]) =>
      h('a', { href: '#' + href, class: path === href ? 'active' : '', 'aria-current': path === href ? 'page' : null }, h('span', { 'aria-hidden': 'true' }, icon), ' ', label))),
    net);
}

async function render(): Promise<void> {
  if (typeof cleanup === 'function') cleanup();
  cleanup = undefined;
  const path = location.hash.replace(/^#/, '') || '/';
  try {
    const a = auth ?? (await refreshAuth());
    if (!a.authenticated) {
      mount(app, loginView(async () => { await refreshAuth(); uploader.start(); void render(); }));
      return;
    }
    for (const [re, view] of routes) {
      const m = path.match(re);
      if (!m) continue;
      const fullscreen = path.endsWith('/scan');
      const main = h('main', { class: fullscreen ? 'main fullscreen' : 'main' });
      mount(app, fullscreen ? null : nav(path), main);
      cleanup = await view(main, ...m.slice(1));
      return;
    }
    go('/');
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) {
      await refreshAuth();
      void render();
      return;
    }
    mount(app, h('main', { class: 'main' }, h('div', { class: 'card error' }, h('h2', null, 'Something went wrong'), h('p', null, (e as Error).message), h('button', { onclick: () => render() }, 'Retry'))));
  }
}

window.addEventListener('hashchange', () => void render());
window.addEventListener('online', () => { uploader.kick(); toast('Back online — resuming uploads', 'ok'); });
window.addEventListener('offline', () => toast('Offline — captures are kept on this phone until upload', 'error'));
onQueueChange(() => {
  const net = document.getElementById('net');
  if (net) void queue.count().then((n) => { net.textContent = `${navigator.onLine ? '● Online' : '○ Offline'}${n ? ` · ${n} pending` : ''}`; });
});

applyTheme();
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
void (async () => {
  await queue.recoverInterrupted();
  if (navigator.storage?.persist) void navigator.storage.persist();
  await render();
  // Uploads need the session's CSRF token, which render() → refreshAuth() loads.
  if (auth?.authenticated) uploader.start();
})();

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  void navigator.serviceWorker.register('/sw.js');
}
