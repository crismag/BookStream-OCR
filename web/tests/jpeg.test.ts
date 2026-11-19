import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { jpegInfo } from '../src/jpeg';

function makeJpeg(w: number, h: number, orientation?: number): ArrayBuffer {
  const path = `/tmp/bs-jpeg-${w}x${h}-${orientation ?? 0}.jpg`;
  execSync(`php -r '$i=imagecreatetruecolor(${w},${h}); imagejpeg($i, "${path}", 80);'`);
  let b = readFileSync(path);
  if (orientation) {
    // insert a minimal big-endian EXIF APP1 with Orientation after SOI
    const tiff = Buffer.from([0x4d, 0x4d, 0, 0x2a, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, orientation, 0, 0, 0, 0, 0, 0, 0, 0]);
    const payload = Buffer.concat([Buffer.from('Exif\0\0', 'binary'), tiff]);
    const app1 = Buffer.concat([Buffer.from([0xff, 0xe1, (payload.length + 2) >> 8, (payload.length + 2) & 255]), payload]);
    b = Buffer.concat([b.subarray(0, 2), app1, b.subarray(2)]);
  }
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
}

describe('jpegInfo', () => {
  it('reads dimensions without decoding', () => {
    expect(jpegInfo(makeJpeg(640, 480))).toEqual({ width: 640, height: 480, orientation: 1 });
  });
  it('swaps dimensions for rotated EXIF orientation', () => {
    expect(jpegInfo(makeJpeg(640, 480, 6))).toEqual({ width: 480, height: 640, orientation: 6 });
  });
  it('rejects non-JPEG data', () => {
    expect(jpegInfo(new Uint8Array([1, 2, 3, 4]).buffer)).toBeNull();
  });
});
