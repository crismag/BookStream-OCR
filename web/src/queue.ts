/**
 * Bounded, durable queue of captures that are not yet confirmed by the server.
 *
 * Two object stores: `pending` holds small metadata records, `blobs` holds the image
 * bytes. Status reads and updates never touch image data, so the scanner can refresh
 * its indicators cheaply. Images live in IndexedDB (never the Android gallery) and are
 * deleted only after the server acknowledged durable storage with a matching checksum.
 */
export type PendingStatus = 'pending' | 'uploading' | 'retrying' | 'blocked';

export interface PendingMeta {
  captureId: string;
  bookId: string;
  captureIndex: number;
  mode: 'single' | 'spread';
  printedPageNumber: string | null;
  sessionId: string;
  checksum: string;
  size: number;
  width?: number;
  height?: number;
  createdAt: number;
  status: PendingStatus;
  attempts: number;
  lastError: string | null;
  nextAttemptAt: number;
  metrics?: Record<string, number>;
}

export interface PendingCapture extends PendingMeta {
  blob: Blob;
}

const DB_NAME = 'bookstream';
const META = 'pending';
const BLOBS = 'blobs';

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

export class CaptureQueue {
  private dbp: Promise<IDBDatabase> | null = null;
  private meta: Map<string, PendingMeta> | null = null;
  private loading: Promise<Map<string, PendingMeta>> | null = null;

  constructor(private factory: IDBFactory = indexedDB) {}

  private db(): Promise<IDBDatabase> {
    this.dbp ??= new Promise((resolve, reject) => {
      const open = this.factory.open(DB_NAME, 2);
      open.onupgradeneeded = (ev) => {
        const db = open.result;
        const tx = open.transaction!;
        if (!db.objectStoreNames.contains(META)) {
          db.createObjectStore(META, { keyPath: 'captureId' }).createIndex('book', 'bookId');
        }
        if (!db.objectStoreNames.contains(BLOBS)) db.createObjectStore(BLOBS);
        // v1 → v2: move image bytes out of the metadata records (no data is dropped).
        if (ev.oldVersion === 1) {
          const metaStore = tx.objectStore(META);
          const blobStore = tx.objectStore(BLOBS);
          metaStore.openCursor().onsuccess = (e) => {
            const cur = (e.target as IDBRequest<IDBCursorWithValue | null>).result;
            if (!cur) return;
            const { blob, ...rest } = cur.value as PendingCapture;
            if (blob) blobStore.put(blob, rest.captureId);
            cur.update(rest);
            cur.continue();
          };
        }
      };
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    return this.dbp;
  }

  private async metaMap(): Promise<Map<string, PendingMeta>> {
    if (this.meta) return this.meta;
    this.loading ??= (async () => {
      const db = await this.db();
      const items = await req(db.transaction(META, 'readonly').objectStore(META).getAll()) as PendingMeta[];
      this.meta = new Map(items.map((i) => [i.captureId, i]));
      return this.meta;
    })();
    return this.loading;
  }

  /** Durable write of image + metadata in one transaction. */
  async put(item: PendingCapture): Promise<void> {
    const { blob, ...meta } = item;
    const db = await this.db();
    const tx = db.transaction([META, BLOBS], 'readwrite');
    tx.objectStore(BLOBS).put(blob, meta.captureId);
    tx.objectStore(META).put(meta);
    await done(tx);
    (await this.metaMap()).set(meta.captureId, meta);
  }

  /** Metadata + image (only when the bytes are actually needed). */
  async get(id: string): Promise<PendingCapture | undefined> {
    const m = (await this.metaMap()).get(id);
    if (!m) return undefined;
    const db = await this.db();
    const blob = await req(db.transaction(BLOBS, 'readonly').objectStore(BLOBS).get(id)) as Blob | undefined;
    return blob ? { ...m, blob } : undefined;
  }

  /** Metadata only, sorted by capture order. Cheap: served from memory. */
  async all(bookId?: string): Promise<PendingMeta[]> {
    const items = [...(await this.metaMap()).values()].filter((i) => !bookId || i.bookId === bookId);
    return items.sort((a, b) => a.captureIndex - b.captureIndex || a.createdAt - b.createdAt);
  }

  async count(): Promise<number> {
    return (await this.metaMap()).size;
  }

  async bytes(): Promise<number> {
    let n = 0;
    for (const m of (await this.metaMap()).values()) n += m.size;
    return n;
  }

  async remove(id: string): Promise<void> {
    const db = await this.db();
    const tx = db.transaction([META, BLOBS], 'readwrite');
    tx.objectStore(META).delete(id);
    tx.objectStore(BLOBS).delete(id);
    await done(tx);
    (await this.metaMap()).delete(id);
  }

  async patch(id: string, changes: Partial<PendingMeta>): Promise<PendingMeta | undefined> {
    const map = await this.metaMap();
    const cur = map.get(id);
    if (!cur) return undefined;
    const next = { ...cur, ...changes };
    const db = await this.db();
    const tx = db.transaction(META, 'readwrite');
    tx.objectStore(META).put(next);
    await done(tx);
    map.set(id, next);
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
