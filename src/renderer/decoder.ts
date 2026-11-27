// Scrcpy sends SPS/PPS in a separate packet. WebCodecs expects those parameter
// sets to accompany the Annex B key frame that starts each decode session.

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

type AvcConfig = { codec: string; data: Uint8Array };

export class H264Decoder {
  private decoder?: VideoDecoder;
  private config?: AvcConfig;
  private activeConfig?: AvcConfig;
  private errorReported = false;

  constructor(private onFrame: (frame: VideoFrame) => void, private onError: (message: string) => void) {}

  push(p: StreamPacket): void {
    if (p.config) {
      const codec = codecFromSps(p.data);
      if (!codec) return this.reportError('Stream config without SPS');
      const previous = this.config?.data;
      if (previous?.length !== p.data.length || !previous.every((byte, i) => byte === p.data[i])) {
        this.config = { codec, data: p.data };
      }
      return;
    }
    const config = this.config;
    if (!config) return;
    const needsConfigure = this.decoder?.state !== 'configured' || this.activeConfig !== config;
    if (needsConfigure && !p.key) return;

    try {
      // Restart at an independent picture if decoding fell behind. An arbitrary
      // dropped delta frame would corrupt the pictures that refer to it.
      if (needsConfigure || (p.key && this.decoder && this.decoder.decodeQueueSize > 6)) {
        this.configure(config);
      }
      let data = p.data;
      if (p.key) {
        data = new Uint8Array(config.data.length + p.data.length);
        data.set(config.data);
        data.set(p.data, config.data.length);
      }
      this.decoder?.decode(new EncodedVideoChunk({ type: p.key ? 'key' : 'delta', timestamp: p.pts, data }));
    } catch (error) {
      this.closeDecoder();
      this.reportError(`Decoder error: ${(error as Error).message}`);
    }
  }

  close(): void {
    this.closeDecoder();
    this.config = undefined;
    this.errorReported = false;
  }

  private closeDecoder(): void {
    if (this.decoder && this.decoder.state !== 'closed') this.decoder.close();
    this.decoder = undefined;
    this.activeConfig = undefined;
  }

  private reportError(message: string): void {
    if (this.errorReported) return;
    this.errorReported = true;
    this.onError(message);
  }

  private configure(config: AvcConfig): void {
    this.closeDecoder();
    const decoder = new VideoDecoder({
      output: (frame) => {
        if (this.decoder !== decoder) return frame.close();
        this.errorReported = false;
        this.onFrame(frame);
      },
      error: (e) => {
        if (this.decoder !== decoder) return;
        this.closeDecoder();
        this.reportError(`Decoder error: ${e.message}`);
      },
    });
    this.decoder = decoder;
    decoder.configure({ codec: config.codec, optimizeForLatency: true, hardwareAcceleration: 'prefer-hardware' });
    this.activeConfig = config;
  }
}
