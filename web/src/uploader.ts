import { ApiError, api } from './api';
import type { CaptureQueue, PendingCapture } from './queue';

export interface Ack {
  status: string;
  capture_id: string;
  checksum: string;
  idempotent_replay: boolean;
  pages: { id: string; side: string; printed_page_number: string | null }[];
}

export type UploadFn = (item: PendingCapture) => Promise<Ack>;

export const defaultUpload: UploadFn = (item) => {
  const fd = new FormData();
  fd.append('capture_id', item.captureId);
  fd.append('checksum', item.checksum);
  fd.append('capture_index', String(item.captureIndex));
  fd.append('mode', item.mode);
  fd.append('session_id', item.sessionId);
  if (item.printedPageNumber !== null) fd.append('printed_page_number', item.printedPageNumber);
  fd.append('image', item.blob, `capture-${item.captureIndex}.jpg`);
  return api<Ack>('POST', `/api/books/${item.bookId}/captures`, fd, { timeoutMs: 120000 });
};

export interface UploaderEvents {
  onConfirmed?: (item: PendingCapture, ack: Ack) => void;
  onChange?: () => void;
}

/**
 * Sequential uploader (keeps server arrival roughly in capture order, avoids
 * saturating a weak mobile link). Exponential backoff with jitter for retryable
 * failures; non-retryable failures are "blocked" and wait for the user.
 */
export class Uploader {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private busy = false;
  private stopped = true;
  public paused = false;

  constructor(
    private queue: CaptureQueue,
    private upload: UploadFn = defaultUpload,
    private events: UploaderEvents = {},
    private opts = { baseDelayMs: 1500, maxDelayMs: 60000, now: () => Date.now() },
  ) {}

  start(): void {
    this.stopped = false;
    this.schedule(0);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Wake up now (new capture, came back online, manual retry). */
  kick(): void {
    if (!this.stopped) this.schedule(0);
  }

  backoff(attempts: number): number {
    const exp = Math.min(this.opts.maxDelayMs, this.opts.baseDelayMs * 2 ** Math.max(0, attempts - 1));
    return Math.round(exp * (0.75 + Math.random() * 0.5));
  }

  private schedule(ms: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.loop(), ms);
  }

  private async loop(): Promise<void> {
    if (this.stopped) return;
    const worked = await this.tick();
    if (this.stopped) return;
    if (worked) return this.schedule(0);
    const items = await this.queue.all();
    const waits = items.filter((i) => i.status === 'retrying').map((i) => i.nextAttemptAt - this.opts.now());
    this.schedule(waits.length ? Math.max(250, Math.min(...waits)) : 5000);
  }

  /** Process at most one eligible item. Returns true if an upload was attempted. */
  async tick(): Promise<boolean> {
    if (this.busy || this.paused) return false;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return false;
    const now = this.opts.now();
    const next = (await this.queue.all()).find((i) => i.status === 'pending' || (i.status === 'retrying' && i.nextAttemptAt <= now));
    if (!next) return false;
    this.busy = true;
    try {
      await this.queue.patch(next.captureId, { status: 'uploading' });
      this.events.onChange?.();
      const ack = await this.upload(next);
      if (ack.status !== 'confirmed' || ack.capture_id !== next.captureId || ack.checksum !== next.checksum) {
        throw new ApiError(0, 'bad_ack', 'Server acknowledgment did not match the capture.');
      }
      await this.queue.remove(next.captureId);
      this.events.onConfirmed?.(next, ack);
    } catch (e) {
      const err = e instanceof ApiError ? e : new ApiError(0, 'unknown', String(e));
      const attempts = next.attempts + 1;
      if (err.retryable) {
        await this.queue.patch(next.captureId, { status: 'retrying', attempts, lastError: err.message, nextAttemptAt: this.opts.now() + this.backoff(attempts) });
      } else {
        await this.queue.patch(next.captureId, { status: 'blocked', attempts, lastError: `${err.code}: ${err.message}` });
      }
    } finally {
      this.busy = false;
      this.events.onChange?.();
    }
    return true;
  }

  async retryNow(id?: string): Promise<void> {
    for (const it of await this.queue.all()) {
      if ((id === undefined || it.captureId === id) && (it.status === 'retrying' || it.status === 'blocked')) {
        await this.queue.patch(it.captureId, { status: 'pending', nextAttemptAt: 0 });
      }
    }
    this.kick();
  }
}
