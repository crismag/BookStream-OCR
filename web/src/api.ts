export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public data: Record<string, unknown> = {}) {
    super(message);
  }
  /** Network errors, timeouts, 429 and 5xx are worth retrying; 4xx validation errors are not. */
  get retryable(): boolean {
    return this.status === 0 || this.status === 408 || this.status === 429 || this.status >= 500 || this.code === 'race';
  }
}

let csrf = '';
export function setCsrf(token: string): void {
  csrf = token;
}

export type Json = Record<string, any>;

export async function api<T = Json>(method: string, path: string, body?: Json | FormData, opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (method !== 'GET') headers['X-CSRF-Token'] = csrf;
  let payload: BodyInit | undefined;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 30000);
  opts.signal?.addEventListener('abort', () => ctl.abort());
  let res: Response;
  try {
    res = await fetch(path, { method, headers, body: payload, credentials: 'same-origin', signal: ctl.signal });
  } catch (e) {
    throw new ApiError(0, 'network', navigator.onLine ? 'Network error or timeout.' : 'You are offline.');
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  let data: Json = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new ApiError(res.status, 'bad_response', `Unexpected server response (${res.status}).`);
  }
  if (!res.ok) {
    if (res.status === 403 && data.error === 'csrf_failed') {
      // refresh token for next try
      try {
        const st = await fetch('/api/auth/state', { credentials: 'same-origin' }).then((r) => r.json());
        if (st.csrf) setCsrf(st.csrf);
      } catch { /* ignore */ }
    }
    throw new ApiError(res.status, String(data.error ?? 'error'), String(data.message ?? res.statusText), data);
  }
  return data as T;
}
