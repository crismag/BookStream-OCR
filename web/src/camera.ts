/**
 * Rear-camera access with three separate resolutions:
 *   1. preview  — a modest 4:3 video stream (default long edge 1920) for a light, page-shaped viewfinder
 *   2. still    — what the camera captures: a frame from the preview when that is already large
 *                 enough for the target, otherwise ImageCapture.takePhoto() at the smallest supported
 *                 width ≥ target (or the sensor maximum for "Maximum")
 *   3. saved    — the stored image, produced by the processing worker (downsampled, never upscaled)
 * Only capabilities the browser actually reports are offered.
 */
declare class ImageCapture {
  constructor(track: MediaStreamTrack);
  takePhoto(settings?: Record<string, unknown>): Promise<Blob>;
  getPhotoCapabilities(): Promise<{ imageWidth?: { min: number; max: number; step: number }; imageHeight?: { min: number; max: number; step: number } }>;
}

export interface CameraCaps {
  torch: boolean;
  stills: boolean;
  stillWidth: { min: number; max: number; step: number } | null;
  pointFocus: boolean;
  manualFocus: { min: number; max: number; step: number } | null;
  zoom: { min: number; max: number; step: number } | null;
  videoWidth: number;
  videoHeight: number;
}

export type Acquired =
  | { kind: 'bitmap'; bitmap: ImageBitmap; width: number; height: number; method: 'frame' }
  | { kind: 'blob'; blob: Blob; method: 'still'; requestedWidth: number | null };

export class Camera {
  stream: MediaStream | null = null;
  track: MediaStreamTrack | null = null;
  private imageCapture: ImageCapture | null = null;
  private torchOn = false;
  caps: CameraCaps = { torch: false, stills: false, stillWidth: null, pointFocus: false, manualFocus: null, zoom: null, videoWidth: 0, videoHeight: 0 };

  static supported(): boolean {
    return !!navigator.mediaDevices?.getUserMedia;
  }

  async start(video: HTMLVideoElement, previewLongEdge = 1920): Promise<CameraCaps> {
    this.stop();
    const long = previewLongEdge, short = Math.round(previewLongEdge * 3 / 4);
    const attempts: MediaStreamConstraints[] = [
      { audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: long }, height: { ideal: short }, aspectRatio: { ideal: 4 / 3 } } },
      { audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: long } } },
      { audio: false, video: true },
    ];
    let lastErr: unknown = null;
    for (const c of attempts) {
      try {
        this.stream = await navigator.mediaDevices.getUserMedia(c);
        break;
      } catch (e) {
        lastErr = e;
        if (e instanceof DOMException && (e.name === 'NotAllowedError' || e.name === 'SecurityError')) throw e;
      }
    }
    if (!this.stream) throw lastErr ?? new Error('Camera unavailable');
    this.track = this.stream.getVideoTracks()[0] ?? null;
    video.srcObject = this.stream;
    video.setAttribute('playsinline', '');
    video.muted = true;
    await video.play().catch(() => undefined);
    await new Promise<void>((r) => (video.readyState >= 2 ? r() : video.addEventListener('loadeddata', () => r(), { once: true })));

    const tc: any = this.track && typeof this.track.getCapabilities === 'function' ? this.track.getCapabilities() : {};
    this.caps = {
      torch: !!tc.torch,
      stills: false,
      stillWidth: null,
      pointFocus: Array.isArray(tc.focusMode) && tc.focusMode.includes('single-shot') && 'pointsOfInterest' in tc,
      manualFocus: Array.isArray(tc.focusMode) && tc.focusMode.includes('manual') && tc.focusDistance ? { min: tc.focusDistance.min, max: tc.focusDistance.max, step: tc.focusDistance.step || 0.01 } : null,
      zoom: tc.zoom ? { min: tc.zoom.min, max: tc.zoom.max, step: tc.zoom.step || 0.1 } : null,
      videoWidth: video.videoWidth,
      videoHeight: video.videoHeight,
    };
    if (this.track && 'ImageCapture' in window) {
      try {
        this.imageCapture = new ImageCapture(this.track);
        const pc = await this.imageCapture.getPhotoCapabilities();
        this.caps.stills = true;
        this.caps.stillWidth = pc.imageWidth ? { min: pc.imageWidth.min, max: pc.imageWidth.max, step: pc.imageWidth.step || 1 } : null;
      } catch {
        this.imageCapture = null;
      }
    }
    if (Array.isArray(tc.focusMode) && tc.focusMode.includes('continuous')) await this.apply({ focusMode: 'continuous' });
    return this.caps;
  }

  private async apply(c: Record<string, unknown>): Promise<boolean> {
    try {
      await this.track?.applyConstraints({ advanced: [c as MediaTrackConstraintSet] });
      return true;
    } catch {
      return false;
    }
  }

  async setTorch(on: boolean): Promise<boolean> {
    if (!this.caps.torch) return false;
    const ok = await this.apply({ torch: on });
    if (ok) this.torchOn = on;
    return ok;
  }

  get torch(): boolean {
    return this.torchOn;
  }

  /** Manual focus distance where supported; null returns to continuous autofocus. */
  async setFocus(distance: number | null): Promise<boolean> {
    if (distance === null) return this.apply({ focusMode: 'continuous' });
    if (!this.caps.manualFocus) return false;
    return this.apply({ focusMode: 'manual', focusDistance: distance });
  }

  async focusAt(x: number, y: number): Promise<boolean> {
    if (!this.caps.pointFocus) return false;
    return this.apply({ pointsOfInterest: [{ x, y }], focusMode: 'single-shot' });
  }

  /** Smallest supported still width ≥ target (sensor max when target is null or too big). */
  chooseStillWidth(target: number | null): number | null {
    const r = this.caps.stillWidth;
    if (!r) return null;
    if (target === null || target >= r.max) return r.max;
    const steps = Math.ceil(Math.max(0, target - r.min) / (r.step || 1));
    return Math.min(r.max, r.min + steps * (r.step || 1));
  }

  /**
   * Acquire one image for a saved long edge of `target` px (null = native).
   * Uses the live preview frame when it already has enough pixels (fast, no camera
   * reconfiguration); otherwise a still photo at the closest supported size.
   */
  async acquire(video: HTMLVideoElement, target: number | null): Promise<Acquired> {
    const previewLong = Math.max(video.videoWidth, video.videoHeight);
    if (this.imageCapture && (target === null || target > previewLong)) {
      try {
        const w = this.chooseStillWidth(target);
        const blob = await this.imageCapture.takePhoto(w ? { imageWidth: w } : {});
        if (this.torchOn) void this.setTorch(true); // some devices drop the torch after a still
        if (blob.size > 0) return { kind: 'blob', blob, method: 'still', requestedWidth: w };
      } catch {
        /* fall back to the preview frame */
      }
    }
    const bitmap = await createImageBitmap(video);
    return { kind: 'bitmap', bitmap, width: bitmap.width, height: bitmap.height, method: 'frame' };
  }

  stop(): void {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.track = null;
    this.imageCapture = null;
    this.torchOn = false;
  }
}

/** Main-thread fallback: resize (never upscale) and encode a Blob. */
export async function prepareForUpload(blob: Blob, maxSide: number, quality: number): Promise<{ blob: Blob; width: number; height: number }> {
  const bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' } as ImageBitmapOptions);
  const scale = maxSide > 0 ? Math.min(1, maxSide / Math.max(bmp.width, bmp.height)) : 1;
  const w = Math.round(bmp.width * scale);
  const h = Math.round(bmp.height * scale);
  if (scale === 1 && blob.type === 'image/jpeg') {
    bmp.close();
    return { blob, width: w, height: h };
  }
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close();
  const out = await new Promise<Blob>((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('Encode failed'))), 'image/jpeg', quality));
  canvas.width = canvas.height = 0;
  return { blob: out, width: w, height: h };
}
