/**
 * Read pixel dimensions and EXIF orientation from a JPEG header without decoding it.
 * Lets the pipeline store a camera JPEG untouched when it already fits the target.
 */
export function jpegInfo(buf: ArrayBuffer): { width: number; height: number; orientation: number } | null {
  const d = new DataView(buf);
  if (d.byteLength < 4 || d.getUint16(0) !== 0xffd8) return null;
  let off = 2;
  let orientation = 1;
  while (off + 4 <= d.byteLength) {
    if (d.getUint8(off) !== 0xff) return null;
    const marker = d.getUint8(off + 1);
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) { off += 2; continue; }
    const len = d.getUint16(off + 2);
    if (marker === 0xe1 && off + 10 < d.byteLength && d.getUint32(off + 4) === 0x45786966) {
      orientation = exifOrientation(d, off + 10) ?? 1;
    }
    // SOF0..SOF15 except DHT(C4), JPG(C8), DAC(CC)
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const height = d.getUint16(off + 5);
      const width = d.getUint16(off + 7);
      return orientation >= 5 ? { width: height, height: width, orientation } : { width, height, orientation };
    }
    off += 2 + len;
  }
  return null;
}

function exifOrientation(d: DataView, tiff: number): number | null {
  if (tiff + 8 > d.byteLength) return null;
  const le = d.getUint16(tiff) === 0x4949;
  const ifd = tiff + d.getUint32(tiff + 4, le);
  if (ifd + 2 > d.byteLength) return null;
  const n = d.getUint16(ifd, le);
  for (let i = 0; i < n; i++) {
    const e = ifd + 2 + i * 12;
    if (e + 12 > d.byteLength) return null;
    if (d.getUint16(e, le) === 0x0112) return d.getUint16(e + 8, le);
  }
  return null;
}
