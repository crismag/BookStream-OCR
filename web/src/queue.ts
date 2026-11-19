/**
 * Bounded, durable queue of captures that are not yet confirmed by the server.
 * Images live in IndexedDB (never in the Android gallery) and are deleted only after the
 * server acknowledged durable storage with a matching checksum.
 */
export type PendingStatus = 'pending' | 'uploading' | 'retrying' | 'blocked';

export interface PendingCapture {
  captureId: string;
  bookId: string;
  captureIndex: number;
  mode: 'single' | 'spread';
  printedPageNumber: string | null;
  sessionId: string;
  blob: Blob;
  checksum: string;
  size: number;
  createdAt: number;
  status: PendingStatus;
  attempts: number;
  lastError: string | null;
  nextAttemptAt: number;
}

const DB_NAME = 'bookstream';
const STORE = 'pending';

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

export class CaptureQueue {
  private dbp: Promise<IDBDatabase> | null = null;

  constructor(private factory: IDBFactory = indexedDB) {}

  private db(): Promise<IDBDatabase> {
    this.dbp ??= new Promise((resolve, reject) => {
      const open = this.factory.open(DB_NAME, 1);
      open.onupgradeneeded = () => {
        const s = open.result.createObjectStore(STORE, { keyPath: 'captureId' });
        s.createIndex('book', 'bookId');
      };
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    return this.dbp;
  }

  private async store(mode: IDBTransactionMode): Promise<IDBObjectStore> {
    return (await this.db()).transaction(STORE, mode).objectStore(STORE);
  }

  async put(item: PendingCapture): Promise<void> {
    await req((await this.store('readwrite')).put(item));
  }

  async get(id: string): Promise<PendingCapture | undefined> {
    return req((await this.store('readonly')).get(id));
  }

  async all(bookId?: string): Promise<PendingCapture[]> {
    const s = await this.store('readonly');
    const items: PendingCapture[] = bookId ? await req(s.index('book').getAll(bookId)) : await req(s.getAll());
    return items.sort((a, b) => a.captureIndex - b.captureIndex || a.createdAt - b.createdAt);
  }

  async count(): Promise<number> {
    return req((await this.store('readonly')).count());
  }

  async remove(id: string): Promise<void> {
    await req((await this.store('readwrite')).delete(id));
  }

  async patch(id: string, changes: Partial<PendingCapture>): Promise<PendingCapture | undefined> {
    const cur = await this.get(id);
    if (!cur) return undefined;
    const next = { ...cur, ...changes };
    await this.put(next);
    return next;
  }

  /** Items whose upload was interrupted (tab closed mid-upload) become pending again. */
  async recoverInterrupted(): Promise<void> {
    for (const it of await this.all()) {
      if (it.status === 'uploading') await this.patch(it.captureId, { status: 'pending' });
    }
  }
}

export async function sha256Hex(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function uuid(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Next printed page number after `n` for a capture producing `pages` logical pages. */
export function advancePageNumber(n: string | null, pages: number): string | null {
  if (n === null || !/^\d+$/.test(n)) return null;
  return String(parseInt(n, 10) + pages);
}
