// View an iPhone/iPad screen on this computer (AirPlay screen mirroring, view only).
//
// macOS has a receiver built in (System Settings → General → AirDrop & Handoff → AirPlay
// Receiver); we only report whether it is on and open its settings.
// Windows uses UxPlay, a separate GPLv3 program bundled in resources/airplay by
// scripts/build-uxplay-windows.sh (license and source notice next to it). iOS never lets
// another device send touches, so neither path can control the phone.
import { ChildProcess, execFile, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { AirPlayStatus } from '../shared/api';
const execute = promisify(execFile);

/** UxPlay logs "connection request from <name> (<model>) with deviceID = …" when a phone connects. */
export function parseClient(log: string): string | undefined {
  const m = log.match(/connection request from (.+?) \(([^)]*)\)/);
  return m ? (m[2] ? `${m[1]} (${m[2]})` : m[1]) : undefined;
}

export class AirPlayReceiver extends EventEmitter {
  private process?: ChildProcess;
  private client?: string;
  private error?: string;

  /** dir: the bundled UxPlay (resources/airplay); stateDir: writable folder for its plugin cache. */
  constructor(private dir: string, private stateDir: string) {
    super();
  }

  private get executable(): string {
    return path.join(this.dir, 'bin', 'uxplay.exe');
  }

  /** Name shown in the iPhone's Screen Mirroring list. */
  get name(): string {
    const host = os.hostname().replace(/\.local$/i, '').replace(/[^\w .-]/g, '').slice(0, 32);
    return `PigPort ${host}`.trim();
  }

  async status(): Promise<AirPlayStatus> {
    if (process.platform === 'darwin') {
      const name = (await execute('/usr/sbin/scutil', ['--get', 'ComputerName']).then((r) => r.stdout.trim(), () => '')) || os.hostname();
      // The key name really is misspelled ("Reciever") in macOS.
      const on = await execute('/usr/bin/defaults', ['-currentHost', 'read', 'com.apple.controlcenter', 'AirplayRecieverEnabled'])
        .then((r) => r.stdout.trim() !== '0', () => true);
      return { platform: 'mac', available: true, running: on, name };
    }
    if (process.platform === 'win32') {
      return { platform: 'windows', available: existsSync(this.executable), running: !!this.process, name: this.name, client: this.client, error: this.error };
    }
    return { platform: 'unsupported', available: false, running: false, name: '' };
  }

  async start(): Promise<void> {
    if (process.platform === 'darwin') {
      await execute('/usr/bin/open', ['x-apple.systempreferences:com.apple.AirDrop-Handoff-Settings.extension']);
      return;
    }
    if (process.platform !== 'win32') throw new Error('Viewing an iPhone screen is available on macOS and Windows.');
    if (this.process) return;
    if (!existsSync(this.executable)) throw new Error('The AirPlay receiver is not included in this build of PigPort.');
    const bin = path.join(this.dir, 'bin');
    const plugins = path.join(this.dir, 'lib', 'gstreamer-1.0');
    // Use only the bundled GStreamer, never one installed elsewhere on the PC.
    const env = {
      ...process.env,
      PATH: `${bin};${process.env.PATH ?? ''}`,
      GST_PLUGIN_PATH: plugins,
      GST_PLUGIN_SYSTEM_PATH: plugins,
      GST_PLUGIN_SCANNER: path.join(this.dir, 'libexec', 'gstreamer-1.0', 'gst-plugin-scanner.exe'),
      GST_REGISTRY: path.join(this.stateDir, 'gstreamer-registry.bin'),
    };
    this.client = undefined;
    this.error = undefined;
    const child = spawn(this.executable, ['-n', this.name, '-nh', '-vs', 'd3d11videosink', '-as', 'wasapisink'], { env, windowsHide: true });
    this.process = child;
    let tail = '';
    const read = (chunk: Buffer) => {
      const text = chunk.toString();
      tail = (tail + text).slice(-2000);
      const client = parseClient(text);
      if (client) {
        this.client = client;
        this.emit('status');
      }
    };
    child.stdout?.on('data', read);
    child.stderr?.on('data', read);
    child.on('error', (e) => { this.error = e.message; });
    child.on('exit', (code) => {
      if (this.process === child) this.process = undefined;
      this.client = undefined;
      if (code && !this.error) this.error = `The AirPlay receiver stopped (code ${code}). ${tail.trim().split('\n').slice(-3).join(' ')}`.trim();
      this.emit('status');
    });
    this.emit('status');
  }

  stop(): void {
    const child = this.process;
    this.process = undefined;
    this.client = undefined;
    child?.kill();
    this.emit('status');
  }
}
