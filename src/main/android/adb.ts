import { execFile, spawn, ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { launchComponent, packageId, pause } from './health';

export interface Device {
  serial: string;
  state: string;
  model?: string;
}

export interface AppPackage {
  id: string;
}

/** A phone advertising Wireless debugging on the local network (adb mDNS). */
export interface WirelessService {
  name: string;
  /** "pairing" while the phone shows a pairing code; "connect" once paired or for legacy adb tcpip. */
  kind: 'pairing' | 'connect';
  address: string;
}

const exe = process.platform === 'win32' ? 'adb.exe' : 'adb';

/** Finds adb: explicit setting, bundled copy, Android SDK, then PATH. */
export function locateAdb(configured?: string, bundledDir?: string): string {
  const candidates: string[] = [];
  if (configured) candidates.push(configured);
  if (bundledDir) candidates.push(path.join(bundledDir, 'platform-tools', exe));
  for (const env of ['ANDROID_HOME', 'ANDROID_SDK_ROOT']) {
    const root = process.env[env];
    if (root) candidates.push(path.join(root, 'platform-tools', exe));
  }
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
  if (process.platform === 'darwin') candidates.push(path.join(home, 'Library/Android/sdk/platform-tools', exe));
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    candidates.push(path.join(process.env.LOCALAPPDATA, 'Android/Sdk/platform-tools', exe));
  }
  return candidates.find((c) => existsSync(c)) ?? exe; // fall back to PATH lookup
}

export class Adb {
  constructor(public binary: string) {}

  run(args: string[], timeoutMs = 60_000): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(this.binary, args, { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, windowsHide: true },
        (err, stdout, stderr) => {
          if (err) {
            const detail = (stderr || stdout || '').trim();
            if (/INSTALL_FAILED_INSUFFICIENT_STORAGE/i.test(detail)) {
              reject(new Error('Not enough storage space on the Android device/emulator. Please free up space or expand disk.'));
              return;
            }
            if (/INSTALL_FAILED_NO_MATCHING_ABIS/i.test(detail)) {
              reject(new Error('This package is not compatible with the CPU architecture of this Android device.'));
              return;
            }
            if (/INSTALL_FAILED_UPDATE_INCOMPATIBLE|INCONSISTENT_CERTIFICATES/i.test(detail)) {
              reject(new Error('Signature mismatch with existing installed version. Uninstall the existing version first.'));
              return;
            }
            if (/INSTALL_FAILED_VERSION_DOWNGRADE/i.test(detail)) {
              reject(new Error('A newer version of this app is already installed on the device.'));
              return;
            }
            reject(new Error(detail ? `adb ${args[0]}: ${detail}` : `adb ${args[0]} failed: ${err.message}`));
          } else {
            resolve(stdout);
          }
        });
    });
  }

  spawn(args: string[]): ChildProcess {
    return spawn(this.binary, args, { windowsHide: true });
  }

  async version(): Promise<string> {
    return (await this.run(['version'], 10_000)).split('\n')[0].trim();
  }

  async devices(): Promise<Device[]> {
    const out = await this.run(['devices', '-l'], 15_000);
    return parseDevices(out);
  }

  /** For emulators or devices that expose adb over TCP. */
  async connect(address: string): Promise<string> {
    const out = (await this.run(['connect', address], 20_000)).trim();
    if (/cannot|failed|unable/i.test(out)) throw new Error(out);
    return out;
  }

  /** Android 11+ Wireless debugging: pair once with the 6-digit code the phone shows. */
  async pair(address: string, code: string): Promise<string> {
    if (!/^[\w.:-]+:\d+$/.test(address)) throw new Error('Enter the pairing address shown on the phone, e.g. 192.168.1.23:41235.');
    if (!/^\d{6}$/.test(code)) throw new Error('Enter the 6-digit pairing code shown on the phone.');
    const out = (await this.run(['pair', address, code], 30_000)).trim();
    if (!/successfully paired/i.test(out)) throw new Error(out || 'Pairing failed');
    return out;
  }

  /** Phones on this network with Wireless debugging on. Empty when mDNS is unavailable. */
  async wireless(): Promise<WirelessService[]> {
    return parseMdnsServices(await this.run(['mdns', 'services'], 10_000).catch(() => ''));
  }

  /** Android 10 and older: switch a USB-connected device to adb over Wi-Fi and connect to it. */
  async enableWifi(serial: string): Promise<string> {
    const ip = parseWlanAddress(await this.shell(serial, ['ip', '-f', 'inet', 'addr', 'show', 'wlan0'], 10_000).catch(() => ''))
      ?? parseWlanAddress(await this.shell(serial, ['ip', 'route'], 10_000).catch(() => ''));
    if (!ip) throw new Error('The device is not on Wi-Fi. Connect it to the same Wi-Fi network as this computer.');
    await this.run(['-s', serial, 'tcpip', '5555'], 20_000);
    // adbd restarts in TCP mode; give it a moment before connecting.
    for (let attempt = 0; ; attempt++) {
      await pause(1500);
      try { return await this.connect(`${ip}:5555`); } catch (e) { if (attempt >= 3) throw e; }
    }
  }

  shell(serial: string, command: string[], timeoutMs?: number): Promise<string> {
    return this.run(['-s', serial, 'shell', ...command], timeoutMs);
  }

  async packages(serial: string): Promise<AppPackage[]> {
    const out = await this.shell(serial, ['pm', 'list', 'packages', '-3']);
    return parsePackages(out);
  }

  /** Native ABIs the device can run, best first (e.g. x86_64, arm64-v8a with ARM translation). */
  async abis(serial: string): Promise<string[]> {
    const list = (await this.shell(serial, ['getprop', 'ro.product.cpu.abilist'])).trim()
      || (await this.shell(serial, ['getprop', 'ro.product.cpu.abi'])).trim();
    return list.split(',').map((a) => a.trim()).filter(Boolean);
  }

  /** Installs one APK, or a split APK set (base + config splits) in one go. */
  async install(serial: string, apks: string[]): Promise<void> {
    if (apks.length === 0) throw new Error('No APK selected');
    const args = apks.length === 1
      ? ['-s', serial, 'install', '-r', apks[0]]
      : ['-s', serial, 'install-multiple', '-r', ...apks];
    const out = await this.run(args, 10 * 60_000);
    if (!/Success/.test(out)) throw new Error(out.trim() || 'Install failed');
  }

  async uninstall(serial: string, pkg: string, keepData = false): Promise<void> {
    const out = await this.run(['-s', serial, 'uninstall', ...(keepData ? ['-k'] : []), pkg]);
    if (!/Success/.test(out)) throw new Error(out.trim() || 'Uninstall failed');
  }

  async launch(serial: string, pkg: string, observationMs = 3000): Promise<void> {
    packageId(pkg);
    const component = launchComponent(await this.shell(serial,
      ['cmd', 'package', 'resolve-activity', '--brief', '-a', 'android.intent.action.MAIN', '-c', 'android.intent.category.LAUNCHER', pkg], 15000), pkg);
    const out = await this.shell(serial, ['am', 'start', '-W', '-n', component], 30000);
    if (/Error:|Exception|Status:\s*(?:timeout|failed)/i.test(out) || !/Status:\s*ok/i.test(out)) throw new Error(`${pkg} could not launch: ${out.trim()}`);
    // Wait for the process to appear (grace period up to 4s)
    const startupDeadline = Date.now() + 4000;
    let alive = '';
    while (Date.now() < startupDeadline) {
      alive = (await this.shell(serial, ['pidof', pkg], 5000).catch(() => '')).trim();
      if (alive) break;
      await pause(300);
    }
    if (!alive) {
      throw new Error(`${pkg} exited during startup. Open Android diagnostics to see the recent crash buffer. This may be a crash or an intentional game exit.`);
    }
    // Sending a launch request is not proof that the process survived startup. Ensure it stays alive.
    const deadline = Date.now() + observationMs;
    while (Date.now() < deadline) {
      await pause(Math.min(750, Math.max(1, deadline - Date.now())));
      alive = (await this.shell(serial, ['pidof', pkg], 5000).catch(() => '')).trim();
      if (!alive) {
        throw new Error(`${pkg} exited during startup. Open Android diagnostics to see the recent crash buffer. This may be a crash or an intentional game exit.`);
      }
    }
  }

  async diagnostics(serial: string, pkg: string): Promise<string> {
    packageId(pkg);
    const sections: string[] = [`Package: ${pkg}`, `Device: ${serial}`, `Captured: ${new Date().toISOString()}`];
    for (const [name, args] of [
      ['CPU ABIs', ['getprop', 'ro.product.cpu.abilist']],
      ['Android version', ['getprop', 'ro.build.version.release']],
      ['Data storage', ['df', '-k', '/data']],
      ['Graphics', ['getprop', 'ro.hardware.egl']],
    ] as [string, string[]][]) {
      sections.push(`\n${name}:\n` + await this.shell(serial, args, 5000).catch((e) => String(e)));
    }
    // Snapshot only; never start an unbounded logcat writer or clear device logs.
    sections.push('\nRecent device crash buffer (may include older or other-app crashes):\n' +
      await this.run(['-s', serial, 'logcat', '-b', 'crash', '-d', '-t', '160', '-v', 'threadtime'], 10000).catch((e) => String(e)));
    return sections.join('\n');
  }

  async forceStop(serial: string, pkg: string): Promise<void> {
    await this.shell(serial, ['am', 'force-stop', pkg]);
  }

  async push(serial: string, local: string, remote: string): Promise<void> {
    await this.run(['-s', serial, 'push', local, remote], 60_000);
  }

  async forward(serial: string, local: string, remote: string): Promise<void> {
    await this.run(['-s', serial, 'forward', local, remote]);
  }

  async removeForward(serial: string, local: string): Promise<void> {
    await this.run(['-s', serial, 'forward', '--remove', local]).catch(() => undefined);
  }
}

export function parseDevices(out: string): Device[] {
  const devices: Device[] = [];
  for (const line of out.split(/\r?\n/).slice(1)) {
    const m = line.trim().match(/^(\S+)\s+(\S+)(.*)$/);
    if (!m) continue;
    const model = m[3].match(/model:(\S+)/)?.[1]?.replace(/_/g, ' ');
    devices.push({ serial: m[1], state: m[2], model });
  }
  return devices;
}

/** Parses `adb mdns services`, e.g. "adb-R58M-AbCd\t_adb-tls-pairing._tcp\t192.168.1.23:41235". */
export function parseMdnsServices(out: string): WirelessService[] {
  const services: WirelessService[] = [];
  for (const line of out.split(/\r?\n/)) {
    const m = line.trim().match(/^(\S+)\s+_adb(-tls-(connect|pairing))?\._tcp\.?\s+(\S+:\d+)$/);
    if (m) services.push({ name: m[1], kind: m[3] === 'pairing' ? 'pairing' : 'connect', address: m[4] });
  }
  return services;
}

/** The device's IPv4 address from `ip addr show wlan0` ("inet 192.168.1.23/24") or `ip route` ("src 192.168.1.23"). */
export function parseWlanAddress(out: string): string | undefined {
  const m = out.match(/\binet (\d+\.\d+\.\d+\.\d+)\//) ?? out.match(/\bwlan\d.*\bsrc (\d+\.\d+\.\d+\.\d+)/);
  return m && m[1] !== '127.0.0.1' ? m[1] : undefined;
}

export function parsePackages(out: string): AppPackage[] {
  return out.split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith('package:'))
    .map((l) => ({ id: l.slice('package:'.length) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}
