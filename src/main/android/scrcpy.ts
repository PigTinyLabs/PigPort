// Client for the scrcpy server (https://github.com/Genymobile/scrcpy), protocol of v5.x.
// The server jar runs on the device, captures the screen as H.264 and accepts
// input events. We only need its wire protocol: the renderer decodes video
// with WebCodecs and turns keymap output into touch messages.

import { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import net from 'node:net';
import { Adb } from './adb';

const REMOTE_JAR = '/data/local/tmp/playbridge-scrcpy-server.jar';

// Control message types and Android constants used by the server.
const MSG_INJECT_KEYCODE = 0;
const MSG_INJECT_TOUCH = 2;
export const ACTION_DOWN = 0;
export const ACTION_UP = 1;
export const ACTION_MOVE = 2;
export const KEYCODE_HOME = 3;
export const KEYCODE_BACK = 4;
export const KEYCODE_APP_SWITCH = 187;

// Media packet header flags (bit 63 is clear for media packets).
const FLAG_CONFIG = 1n << 62n;
const FLAG_KEY_FRAME = 1n << 61n;
const PTS_MASK = FLAG_KEY_FRAME - 1n;

export interface StreamOptions {
  maxSize: number;
  maxFps: number;
  bitRate: number;
}

export interface StreamMeta {
  deviceName: string;
  codec: string;
  width: number;
  height: number;
}

export interface StreamPacket {
  config: boolean;
  key: boolean;
  /** Microseconds; 0 for config packets. */
  pts: number;
  data: Uint8Array;
}

export function encodeTouch(action: number, pointerId: number, x: number, y: number,
  width: number, height: number): Buffer {
  const b = Buffer.alloc(32);
  b.writeUInt8(MSG_INJECT_TOUCH, 0);
  b.writeUInt8(action, 1);
  b.writeBigInt64BE(BigInt(pointerId), 2);
  b.writeInt32BE(Math.round(x), 10);
  b.writeInt32BE(Math.round(y), 14);
  b.writeUInt16BE(width, 18);
  b.writeUInt16BE(height, 20);
  b.writeUInt16BE(action === ACTION_UP ? 0 : 0xffff, 22); // pressure, 16-bit fixed point
  b.writeUInt32BE(0, 24); // action button (none for a finger)
  b.writeUInt32BE(0, 28); // buttons
  return b;
}

export function encodeKeycode(action: number, keycode: number): Buffer {
  const b = Buffer.alloc(14);
  b.writeUInt8(MSG_INJECT_KEYCODE, 0);
  b.writeUInt8(action, 1);
  b.writeInt32BE(keycode, 2);
  b.writeInt32BE(0, 6); // repeat
  b.writeInt32BE(0, 10); // meta state
  return b;
}

/**
 * Incremental parser for the video socket (scrcpy 5.x framing):
 * dummy byte, 64-byte device name, 4-byte codec id, then 12-byte headers.
 * A header with the MSB set is a session packet (new capture size, e.g. after
 * rotation); otherwise it is [pts+flags u64][size u32] followed by the payload.
 */
export class VideoStreamParser {
  private buf: Buffer = Buffer.alloc(0);
  private stage: 'dummy' | 'device' | 'codec' | 'header' | 'payload' = 'dummy';
  private deviceName = '';
  private codec = '';
  private ptsFlags = 0n;
  private size = 0;

  constructor(private onMeta: (m: StreamMeta) => void, private onPacket: (p: StreamPacket) => void,
    skipDummyByte = false) {
    if (skipDummyByte) this.stage = 'device';
  }

  push(chunk: Buffer): void {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    for (;;) {
      const need = { dummy: 1, device: 64, codec: 4, header: 12, payload: this.size }[this.stage];
      if (this.buf.length < need) return;
      const part = this.buf.subarray(0, need);
      this.buf = this.buf.subarray(need);
      switch (this.stage) {
        case 'dummy':
          this.stage = 'device';
          break;
        case 'device':
          this.deviceName = part.toString('utf8').replace(/\0.*$/s, '');
          this.stage = 'codec';
          break;
        case 'codec':
          this.codec = part.toString('latin1').replace(/\0/g, '');
          this.stage = 'header';
          break;
        case 'header':
          if (part[0] & 0x80) {
            this.onMeta({ deviceName: this.deviceName, codec: this.codec,
              width: part.readUInt32BE(4), height: part.readUInt32BE(8) });
          } else {
            this.ptsFlags = part.readBigUInt64BE(0);
            this.size = part.readUInt32BE(8);
            this.stage = 'payload';
          }
          break;
        case 'payload': {
          const config = (this.ptsFlags & FLAG_CONFIG) !== 0n;
          this.onPacket({
            config,
            key: (this.ptsFlags & FLAG_KEY_FRAME) !== 0n,
            pts: config ? 0 : Number(this.ptsFlags & PTS_MASK),
            data: new Uint8Array(part), // copy: the backing buffer is reused
          });
          this.stage = 'header';
          break;
        }
      }
    }
  }
}

export interface SessionEvents {
  meta: (m: StreamMeta) => void;
  packet: (p: StreamPacket) => void;
  log: (line: string) => void;
  closed: (reason: string) => void;
}

export declare interface ScrcpySession {
  on<E extends keyof SessionEvents>(event: E, listener: SessionEvents[E]): this;
  emit<E extends keyof SessionEvents>(event: E, ...args: Parameters<SessionEvents[E]>): boolean;
}

export class ScrcpySession extends EventEmitter {
  private server?: ChildProcess;
  private video?: net.Socket;
  private control?: net.Socket;
  private localPort = 0;
  private closed = false;

  constructor(private adb: Adb, readonly serial: string, private serverJar: string,
    private serverVersion: string, private opts: StreamOptions) {
    super();
  }

  async start(): Promise<void> {
    const scid = (Math.floor(Math.random() * 0x7fffffff) >>> 0).toString(16).padStart(8, '0');
    await this.adb.push(this.serial, this.serverJar, REMOTE_JAR);
    this.localPort = await freePort();
    await this.adb.forward(this.serial, `tcp:${this.localPort}`, `localabstract:scrcpy_${scid}`);

    const args = [
      `scid=${scid}`, 'log_level=info', 'tunnel_forward=true', 'audio=false', 'control=true',
      'video_codec=h264', `max_size=${this.opts.maxSize}`, `max_fps=${this.opts.maxFps}`,
      `video_bit_rate=${this.opts.bitRate}`, 'stay_awake=true', 'cleanup=true',
    ];
    this.server = this.adb.spawn(['-s', this.serial, 'shell',
      `CLASSPATH=${REMOTE_JAR}`, 'app_process', '/', 'com.genymobile.scrcpy.Server',
      this.serverVersion, ...args]);
    const log = (d: Buffer) => d.toString().split(/\r?\n/).filter(Boolean).forEach((l) => this.emit('log', l));
    this.server.stdout?.on('data', log);
    this.server.stderr?.on('data', log);
    this.server.on('exit', (code) => this.shutdown(`scrcpy server exited (code ${code})`));

    let videoRest: Buffer = Buffer.alloc(0);
    try {
      // In forward mode the server listens on the device; adb accepts our
      // connection before the server is ready, so retry until the dummy byte arrives.
      const { socket, rest } = await this.connectWithDummyByte(10_000);
      this.video = socket;
      videoRest = rest;
      this.control = await connect(this.localPort);
    } catch (e) {
      this.shutdown((e as Error).message);
      throw e;
    }

    const parser = new VideoStreamParser((m) => this.emit('meta', m), (p) => this.emit('packet', p), true);
    if (videoRest.length) parser.push(videoRest);
    this.video.on('data', (d) => parser.push(d));
    this.video.resume();
    this.video.on('close', () => this.shutdown('video stream closed'));
    this.video.on('error', (e) => this.shutdown(e.message));
    this.control.on('data', () => undefined); // device messages (clipboard etc.) are ignored
    this.control.on('error', (e) => this.shutdown(e.message));
  }

  touch(action: number, pointerId: number, x: number, y: number, width: number, height: number): void {
    this.control?.write(encodeTouch(action, pointerId, x, y, width, height));
  }

  key(keycode: number): void {
    this.control?.write(encodeKeycode(ACTION_DOWN, keycode));
    this.control?.write(encodeKeycode(ACTION_UP, keycode));
  }

  stop(): void {
    this.shutdown('stopped');
  }

  /** Returns the socket (paused) and whatever arrived after the dummy byte. */
  private async connectWithDummyByte(timeoutMs: number): Promise<{ socket: net.Socket; rest: Buffer }> {
    const deadline = Date.now() + timeoutMs;
    let lastError = 'timed out';
    while (Date.now() < deadline && !this.closed) {
      try {
        const socket = await connect(this.localPort);
        const first = await firstData(socket, 2_000);
        if (first) return { socket, rest: first.subarray(1) };
        socket.destroy();
      } catch (e) {
        lastError = (e as Error).message;
      }
      await new Promise((r) => setTimeout(r, 150));
    }
    throw new Error(`Could not connect to the scrcpy server: ${lastError}. ` +
      'Check that the scrcpy-server version matches resources/scrcpy-server.version.');
  }

  private shutdown(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.video?.destroy();
    this.control?.destroy();
    this.server?.kill();
    if (this.localPort) void this.adb.removeForward(this.serial, `tcp:${this.localPort}`);
    this.emit('closed', reason);
  }
}

function connect(port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const s = net.connect({ host: '127.0.0.1', port }, () => {
      s.off('error', reject);
      s.setNoDelay(true);
      resolve(s);
    });
    s.once('error', reject);
  });
}

/** Resolves with the first chunk, or undefined if the socket closes first. */
function firstData(socket: net.Socket, timeoutMs: number): Promise<Buffer | undefined> {
  return new Promise((resolve) => {
    const done = (v: Buffer | undefined) => {
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('close', onClose);
      socket.off('error', onClose);
      if (v) socket.pause();
      resolve(v);
    };
    const onData = (d: Buffer) => done(d);
    const onClose = () => done(undefined);
    const timer = setTimeout(onClose, timeoutMs);
    socket.on('data', onData);
    socket.once('close', onClose);
    socket.once('error', onClose);
  });
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}
