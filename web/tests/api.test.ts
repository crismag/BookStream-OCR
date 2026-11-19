import { describe, expect, it } from 'vitest';
import { ApiError } from '../src/api';

describe('ApiError.retryable', () => {
  it('retries transient and session problems, blocks real conflicts', () => {
    expect(new ApiError(0, 'network', '').retryable).toBe(true);
    expect(new ApiError(503, 'x', '').retryable).toBe(true);
    expect(new ApiError(403, 'csrf_failed', '').retryable).toBe(true);
    expect(new ApiError(401, 'unauthenticated', '').retryable).toBe(true);
    expect(new ApiError(409, 'capture_conflict', '').retryable).toBe(false);
    expect(new ApiError(422, 'checksum_mismatch', '').retryable).toBe(false);
  });
});
