import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it, beforeEach } from 'vitest';
import { ApiError } from '../src/api';
import { CaptureQueue, PendingCapture, advancePageNumber, sha256Hex, uuid } from '../src/queue';
import { Ack, Uploader } from '../src/uploader';

let queue: CaptureQueue;
let clock = 1_000_000;
const now = () => clock;

function item(i: number, extra: Partial<PendingCapture> = {}): PendingCapture {
  return {
    captureId: uuid(), bookId: 'b1', captureIndex: i, mode: 'single', printedPageNumber: String(i), sessionId: 's',
    blob: new Blob([`img-${i}`], { type: 'image/jpeg' }), checksum: `sum-${i}`, size: 5, createdAt: i,
    status: 'pending', attempts: 0, lastError: null, nextAttemptAt: 0, ...extra,
  };
}

function ackFor(p: PendingCapture): Ack {
  return { status: 'confirmed', capture_id: p.captureId, checksum: p.checksum, idempotent_replay: false, pages: [] };
}

beforeEach(() => {
  queue = new CaptureQueue(new IDBFactory());
  clock = 1_000_000;
});

describe('Uploader', () => {
  it('uploads in capture order and deletes only after a matching ack', async () => {
    const seen: number[] = [];
    const up = new Uploader(queue, async (p) => { seen.push(p.captureIndex); return ackFor(p); }, {}, { baseDelayMs: 1000, maxDelayMs: 8000, now });
    for (const i of [3, 1, 2]) await queue.put(item(i));
    while (await up.tick());
    expect(seen).toEqual([1, 2, 3]);
    expect(await queue.count()).toBe(0);
  });

  it('keeps the capture when the ack checksum does not match', async () => {
    const up = new Uploader(queue, async (p) => ({ ...ackFor(p), checksum: 'other' }), {}, { baseDelayMs: 1000, maxDelayMs: 8000, now });
    const p = item(1);
    await queue.put(p);
    await up.tick();
    const left = await queue.get(p.captureId);
    expect(left?.status).toBe('retrying');
    expect(left?.blob).toBeDefined();
  });

  it('retries with exponential backoff on network errors, then succeeds', async () => {
    let calls = 0;
    const up = new Uploader(queue, async (p) => {
      calls++;
      if (calls < 3) throw new ApiError(0, 'network', 'offline');
      return ackFor(p);
    }, {}, { baseDelayMs: 1000, maxDelayMs: 8000, now });
    const p = item(1);
    await queue.put(p);
    await up.tick();
    const a1 = await queue.get(p.captureId);
    expect(a1?.attempts).toBe(1);
    expect(await up.tick()).toBe(false); // not yet due
    clock = a1!.nextAttemptAt;
    await up.tick();
    const a2 = await queue.get(p.captureId);
    expect(a2!.nextAttemptAt - clock).toBeGreaterThanOrEqual(1500); // ~2s ±25%
    clock = a2!.nextAttemptAt;
    await up.tick();
    expect(await queue.count()).toBe(0);
    expect(calls).toBe(3);
  });

  it('blocks non-retryable errors (e.g. conflict) until the user retries', async () => {
    let fail = true;
    const up = new Uploader(queue, async (p) => {
      if (fail) throw new ApiError(409, 'capture_conflict', 'conflict');
      return ackFor(p);
    }, {}, { baseDelayMs: 1000, maxDelayMs: 8000, now });
    const p = item(1);
    await queue.put(p);
    await up.tick();
    expect((await queue.get(p.captureId))?.status).toBe('blocked');
    expect(await up.tick()).toBe(false);
    fail = false;
    await up.retryNow(p.captureId);
    up.stop();
    await up.tick();
    expect(await queue.count()).toBe(0);
  });

  it('treats idempotent replay (ack lost, re-sent) as confirmed', async () => {
    const up = new Uploader(queue, async (p) => ({ ...ackFor(p), idempotent_replay: true }), {}, { baseDelayMs: 1000, maxDelayMs: 8000, now });
    await queue.put(item(1));
    await up.tick();
    expect(await queue.count()).toBe(0);
  });

  it('recovers items interrupted mid-upload after reload', async () => {
    const p = item(1, { status: 'uploading' });
    await queue.put(p);
    await queue.recoverInterrupted();
    expect((await queue.get(p.captureId))?.status).toBe('pending');
  });

  it('does nothing while paused', async () => {
    const up = new Uploader(queue, async (p) => ackFor(p), {}, { baseDelayMs: 1000, maxDelayMs: 8000, now });
    up.paused = true;
    await queue.put(item(1));
    expect(await up.tick()).toBe(false);
  });

  it('runs two uploads in parallel without uploading the same capture twice', async () => {
    let active = 0, peak = 0;
    const seen: string[] = [];
    const up = new Uploader(queue, async (p) => {
      active++; peak = Math.max(peak, active); seen.push(p.captureId);
      await new Promise((r) => setTimeout(r, 20));
      active--;
      return ackFor(p);
    }, {}, { baseDelayMs: 1000, maxDelayMs: 8000, now });
    for (let i = 1; i <= 4; i++) await queue.put(item(i));
    await Promise.all([up.tick(), up.tick(), up.tick()]);
    expect(peak).toBe(2);
    expect(new Set(seen).size).toBe(seen.length);
    while (await up.tick());
    expect(await queue.count()).toBe(0);
    expect(new Set(seen).size).toBe(4);
  });

  it('drops to one slot after network failure and recovers after 3 successes', async () => {
    let fail = true;
    const up = new Uploader(queue, async (p) => {
      if (fail) { fail = false; throw new ApiError(0, 'network', 'timeout'); }
      return ackFor(p);
    }, {}, { baseDelayMs: 1, maxDelayMs: 1, now });
    expect(up.effective).toBe(2);
    for (let i = 1; i <= 5; i++) await queue.put(item(i));
    await up.tick();
    expect(up.effective).toBe(1);
    clock += 10;
    for (let i = 0; i < 3; i++) await up.tick();
    expect(up.effective).toBe(2);
  });

  it('status reads do not load image bytes; images survive until confirmed', async () => {
    const p = item(1);
    await queue.put(p);
    const meta = (await queue.all())[0] as any;
    expect(meta.blob).toBeUndefined();
    expect((await queue.get(p.captureId))?.blob).toBeDefined(); // fake IDB clones Blob shape; real browsers keep bytes
    expect(await queue.bytes()).toBe(5);
    // a fresh queue instance (page reload) sees the same item
    const again = new CaptureQueue((queue as any).factory);
    expect((await again.all()).map((i) => i.captureId)).toEqual([p.captureId]);
  });

  it('handles 30 consecutive captures', async () => {
    const up = new Uploader(queue, async (p) => ackFor(p), {}, { baseDelayMs: 1000, maxDelayMs: 8000, now });
    for (let i = 1; i <= 30; i++) await queue.put(item(i));
    let n = 0;
    while (await up.tick()) n++;
    expect(n).toBe(30);
    expect(await queue.count()).toBe(0);
  });
});

describe('helpers', () => {
  it('advances printed page numbers', () => {
    expect(advancePageNumber('12', 1)).toBe('13');
    expect(advancePageNumber('12', 2)).toBe('14');
    expect(advancePageNumber('xii', 1)).toBeNull();
    expect(advancePageNumber(null, 1)).toBeNull();
  });

  it('computes sha256 like the server', async () => {
    const hex = await sha256Hex(new Blob(['abc']));
    expect(hex).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('makes v4 uuids', () => {
    expect(uuid()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
