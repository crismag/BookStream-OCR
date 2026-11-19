import { api } from '../api';
import { auth, setAuthed } from '../state';
import { h, toast } from '../ui';

export function loginView(done: () => void): HTMLElement {
  const setup = !!auth?.setup_required;
  const err = h('p', { class: 'form-error', role: 'alert' });
  const user = h('input', { name: 'username', autocomplete: 'username', required: true, autocapitalize: 'none' });
  const pass = h('input', { name: 'password', type: 'password', autocomplete: setup ? 'new-password' : 'current-password', required: true, minlength: setup ? 10 : null });
  const token = h('input', { name: 'setup_token', type: 'password', autocomplete: 'off', required: true });
  const btn = h('button', { type: 'submit', class: 'primary big' }, setup ? 'Create account' : 'Sign in');

  const form = h('form', {
    class: 'card narrow',
    onsubmit: async (ev: Event) => {
      ev.preventDefault();
      err.textContent = '';
      btn.disabled = true;
      try {
        const body = setup ? { setup_token: token.value, username: user.value, password: pass.value } : { username: user.value, password: pass.value };
        const r = await api<{ user: { id: string; username: string }; csrf: string }>('POST', setup ? '/api/auth/setup' : '/api/auth/login', body);
        setAuthed(r.user, r.csrf);
        toast(`Welcome, ${r.user.username}`, 'ok');
        done();
      } catch (e) {
        err.textContent = (e as Error).message;
      } finally {
        btn.disabled = false;
      }
    },
  },
  h('h1', null, 'BookStream OCR'),
  h('p', { class: 'muted' }, setup ? 'First-time setup: create the owner account.' : 'Sign in to continue scanning.'),
  setup && !auth?.setup_enabled ? h('p', { class: 'form-error' }, 'Setup is disabled. Set SETUP_TOKEN (12+ characters) in the server .env file.') : null,
  setup ? h('label', null, 'Setup token (from .env)', token) : null,
  h('label', null, 'Username', user),
  h('label', null, 'Password', pass),
  err,
  btn);
  return h('main', { class: 'main center' }, form);
}
