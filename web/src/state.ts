import { api, setCsrf } from './api';
import { CaptureQueue } from './queue';
import { Uploader } from './uploader';

export interface AuthState {
  setup_required: boolean;
  setup_enabled: boolean;
  authenticated: boolean;
  user: { id: string; username: string } | null;
  csrf: string;
  limits: { max_upload_bytes: number; max_pending: number };
}

export interface Book {
  id: string;
  title: string;
  author: string;
  description: string;
  expected_page_count: number | null;
  languages: string[];
  original_language: string;
  translation_language: string;
  default_layout: string;
  archived: boolean;
  last_activity: string;
  stats: { captures: number; pages: number; ocr_done: number; ocr_failed: number; reviewed: number; missing_count: number };
  next_capture_index: number;
  next_printed_page: string | null;
}

export const queue = new CaptureQueue();
const listeners = new Set<() => void>();
export function onQueueChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
export const uploader = new Uploader(queue, undefined, {
  onChange: () => listeners.forEach((f) => f()),
  onConfirmed: () => listeners.forEach((f) => f()),
});

export let auth: AuthState | null = null;

export async function refreshAuth(): Promise<AuthState> {
  auth = await api<AuthState>('GET', '/api/auth/state');
  setCsrf(auth.csrf);
  return auth;
}

export function setAuthed(user: { id: string; username: string }, csrf: string): void {
  setCsrf(csrf);
  if (auth) {
    auth.authenticated = true;
    auth.user = user;
    auth.csrf = csrf;
    auth.setup_required = false;
  }
}
