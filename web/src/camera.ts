/**
 * Rear-camera capture. On Android Chrome / Samsung Internet (Galaxy S24) the
 * ImageCapture API returns full-resolution stills; elsewhere we grab the video frame.
 * Only capabilities the browser actually reports are offered in the UI.
 */
declare class ImageCapture {
  constructor(track: MediaStreamTrack);
  takePhoto(settings?: Record<string, unknown>): Promise<Blob>;
  getPhotoCapabilities(): Promise<{ imageWidth?: { max: number }; imageHeight?: { max: number }; fillLightMode?: string[] }>;
}

export interface CameraCaps {
  torch: boolean;
  fullResStill: boolean;
  pointFocus: boolean;
  zoom: { min: number; max: number; step: number } | null;
  stillMaxWidth: number | null;
  videoWidth: number;
  videoHeight: number;
}

export class Camera {
  stream: MediaStream | null = null;
  track: MediaStreamTrack | null = null;
  private imageCapture: ImageCapture | null = null;
  private torchOn = false;
  caps: CameraCaps = { torch: false, fullResStill: false, pointFocus: false, zoom: null, stillMaxWidth: null, videoWidth: 0, videoHeight: 0 };

  static supported(): boolean {
    return !!navigator.mediaDevices?.getUserMedia;
  }

  async start(video: HTMLVideoElement): Promise<CameraCaps> {
    this.stop();
    const attempts: MediaStreamConstraints[] = [
      { audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 3840 }, height: { ideal: 2160 } } },
      { audio: false, video: { facingMode: { ideal: 'environment' } } },
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
      fullResStill: false,
      pointFocus: Array.isArray(tc.focusMode) && tc.focusMode.includes('single-shot') && 'pointsOfInterest' in tc,
      zoom: tc.zoom ? { min: tc.zoom.min, max: tc.zoom.max, step: tc.zoom.step || 0.1 } : null,
      stillMaxWidth: null,
      videoWidth: video.videoWidth,
      videoHeight: video.videoHeight,
    };
    if (this.track && 'ImageCapture' in window) {
      try {
        this.imageCapture = new ImageCapture(this.track);
        const pc = await this.imageCapture.getPhotoCapabilities();
        this.caps.fullResStill = true;
        this.caps.stillMaxWidth = pc.imageWidth?.max ?? null;
      } catch {
        this.imageCapture = null;
      }
    }
    if (Array.isArray(tc.focusMode) && tc.focusMode.includes('continuous')) {
      await this.apply({ focusMode: 'continuous' });
    }
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

  async setZoom(z: number): Promise<void> {
    if (this.caps.zoom) await this.apply({ zoom: z });
  }

  /** Tap-to-focus where supported; x,y normalized 0..1. */
  async focusAt(x: number, y: number): Promise<boolean> {
    if (!this.caps.pointFocus) return false;
    return this.apply({ pointsOfInterest: [{ x, y }], focusMode: 'single-shot' });
  }

  async capture(video: HTMLVideoElement): Promise<{ blob: Blob; method: 'still' | 'frame' }> {
    if (this.imageCapture) {
      try {
        const opts: Record<string, unknown> = {};
        if (this.caps.stillMaxWidth) opts.imageWidth = this.caps.stillMaxWidth;
        const blob = await this.imageCapture.takePhoto(opts);
        // takePhoto can turn the torch off on some devices; restore it.
        if (this.torchOn) void this.setTorch(true);
        if (blob.size > 0) return { blob, method: 'still' };
      } catch {
        /* fall back to frame grab */
      }
    }
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d')!.drawImage(video, 0, 0);
    const blob = await new Promise<Blob>((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('Frame capture failed'))), 'image/jpeg', 0.95));
    canvas.width = canvas.height = 0;
    return { blob, method: 'frame' };
  }

  stop(): void {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.track = null;
    this.imageCapture = null;
    this.torchOn = false;
  }
}

/**
 * Resize (only if larger than maxSide) and re-encode as JPEG for upload, honouring
 * EXIF orientation. Quality stays high: text legibility matters more than bytes.
 */
export async function prepareForUpload(blob: Blob, maxSide: number, quality: number): Promise<{ blob: Blob; width: number; height: number }> {
  const bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' } as ImageBitmapOptions);
  const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const w = Math.round(bmp.width * scale);
  const h = Math.round(bmp.height * scale);
  if (scale === 1 && blob.type === 'image/jpeg' && blob.size < 12 * 1024 * 1024) {
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
  canvas.width = canvas.height = 0; // release memory promptly
  return { blob: out, width: w, height: h };
}
