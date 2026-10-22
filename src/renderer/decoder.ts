// H.264 (Annex B) decoding with WebCodecs. scrcpy sends SPS/PPS as a separate
// "config" packet; it is prepended to the next frame, which is a key frame.

import type { StreamPacket } from '../shared/api';

export function codecFromSps(data: Uint8Array): string | undefined {
  for (let i = 0; i + 4 < data.length; i++) {
    if (data[i] !== 0 || data[i + 1] !== 0) continue;
    const start = data[i + 2] === 1 ? i + 3 : data[i + 2] === 0 && data[i + 3] === 1 ? i + 4 : -1;
    if (start < 0 || start + 3 >= data.length) continue;
    if ((data[start] & 0x1f) === 7) {
      const hex = (b: number) => b.toString(16).padStart(2, '0');
      return `avc1.${hex(data[start + 1])}${hex(data[start + 2])}${hex(data[start + 3])}`;
    }
  }
  return undefined;
}

export class H264Decoder {
  private decoder?: VideoDecoder;
  private codec?: string;
  private config?: Uint8Array;
  private needKeyFrame = true;

  constructor(private onFrame: (frame: VideoFrame) => void, private onError: (message: string) => void) {}

  push(p: StreamPacket): void {
    if (p.config) {
      this.config = p.data;
      const codec = codecFromSps(p.data);
      if (!codec) return this.onError('Stream config without SPS');
      if (codec !== this.codec || !this.decoder || this.decoder.state === 'closed') this.configure(codec);
      return;
    }
    if (!this.decoder || this.decoder.state !== 'configured') return;
    if (this.needKeyFrame && !p.key) return;

    let data = p.data;
    if (this.config) {
      data = new Uint8Array(this.config.length + p.data.length);
      data.set(this.config);
      data.set(p.data, this.config.length);
      this.config = undefined;
    }
    this.needKeyFrame = false;
    this.decoder.decode(new EncodedVideoChunk({ type: p.key ? 'key' : 'delta', timestamp: p.pts, data }));
  }

  close(): void {
    if (this.decoder && this.decoder.state !== 'closed') this.decoder.close();
    this.decoder = undefined;
    this.codec = undefined;
  }

  private configure(codec: string): void {
    this.close();
    this.codec = codec;
    this.needKeyFrame = true;
    this.decoder = new VideoDecoder({
      output: (frame) => this.onFrame(frame),
      error: (e) => {
        this.onError(`Decoder error: ${e.message}`);
        this.codec = undefined; // force a fresh decoder on the next config packet
      },
    });
    this.decoder.configure({ codec, optimizeForLatency: true, hardwareAcceleration: 'prefer-hardware' });
  }
}
