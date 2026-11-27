import { existsSync, promises as fs } from 'node:fs';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import type { AndroidGraphics, AndroidResolution, Device } from '../../shared/api';
import { Adb } from '../android/adb';
import { androidIsReady, pause, TextTail, waitForAndroid } from '../android/health';
import { GOOGLE_PLAY_AVD } from './managedAndroid';
import { prepareQuickBoot, type QuickBoot } from './quickBoot';
const execute = promisify(execFile);

const appleSilicon = process.platform === 'darwin' && process.arch === 'arm64';
type StartOptions = { mode?: 'direct' | 'restart'; resolution?: AndroidResolution; progress?: (message: string) => void };
type DisplaySize = Exclude<AndroidResolution, 'auto'>;
type EmulatorOptions = { size?: DisplaySize; limitedMemory?: boolean; angle?: boolean; quickBoot?: QuickBoot };
const scales: Record<DisplaySize, number> = { '800x500': 0.625, '960x600': 0.75, '1280x800': 1 };
const booting = new Map<string, { mode: StartOptions['mode']; task: Promise<string> }>();
const directWindows = new Map<string, { serial: string; child: ChildProcess }>();
type ManagedSetup = { sdk: string; avdHome: string; profiles: readonly string[] };
let managed: ManagedSetup | undefined;
export function configureManagedAndroid(setup?: ManagedSetup): void { managed = setup; }
const emulatorEnv = () => managed ? { ...process.env, ANDROID_HOME: managed.sdk, ANDROID_SDK_ROOT: managed.sdk, ANDROID_AVD_HOME: managed.avdHome } : process.env;

export function sdkRoots(): string[] {
  return [...new Set([managed?.sdk, process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT,
    process.platform === 'darwin' ? path.join(os.homedir(), 'Library/Android/sdk') : undefined,
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Android/Sdk') : undefined,
  ].filter((s): s is string => !!s))];
}
export function sdkTool(folder: string, tool: string): string | undefined {
  const exe = tool + (process.platform === 'win32' ? '.exe' : '');
  return sdkRoots().map((root) => path.join(root, folder, exe)).find(existsSync);
}
export async function avds(): Promise<string[]> {
  const binary = sdkTool('emulator', 'emulator');
  if (!binary) return [];
  const { stdout } = await execute(binary, ['-list-avds'], { timeout: 15000, windowsHide: true, env: emulatorEnv() });
  return stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

/** Select explicitly, reuse the only device, or boot an existing SDK virtual device. */
export async function ensureAndroid(adb: Adb, serial?: string, preferredAvd?: string, graphics: AndroidGraphics = 'auto', options: StartOptions = {}): Promise<string> {
  const { mode } = options;
  const devices = await adb.devices();
  const ready = devices.filter((d) => d.state === 'device');
  if (serial) {
    if (!ready.some((d) => d.serial === serial)) throw new Error('Selected Android device disconnected. Refresh devices and retry.');
    await waitForAndroid(adb, serial);
    return serial;
  }
  if (!mode && ready.length > 1) throw new Error('Choose the Android device to install on in the sidebar.');
  if (!mode && ready.length === 1) { await waitForAndroid(adb, ready[0].serial); return ready[0].serial; }
  if (!mode && devices.some((d) => d.state === 'unauthorized')) throw new Error('Allow USB debugging on the connected phone, then retry.');
  const names = await avds();
  const name = preferredAvd || (mode ? managed?.profiles[0] : names.length === 1 ? names[0] : undefined);
  if (!name || !names.includes(name)) throw new Error(names.length
    ? 'Choose an Android virtual device in Settings, then retry.'
    : 'Set up built-in Android from Game library, then retry.');
  const existing = booting.get(name);
  if (existing) {
    if (!mode || mode === existing.mode) return existing.task;
    throw new Error('Wait for Android to finish starting, then retry.');
  }
  const task = startAvd(adb, name, graphics, options).finally(() => booting.delete(name));
  booting.set(name, { mode, task });
  return task;
}

export async function managedAndroidDevices(adb: Adb, devices?: Device[]): Promise<Map<string, string>> {
  if (!managed) return new Map();
  const profiles = managed.profiles;
  return new Map((await emulatorNames(adb, devices)).filter(([, name]) => profiles.includes(name)));
}

async function emulatorNames(adb: Adb, devices?: Device[]): Promise<[string, string][]> {
  const emulators = (devices ?? await adb.devices()).filter((device) => /^emulator-\d+$/.test(device.serial));
  return Promise.all(emulators.map(async ({ serial }) => {
    const name = await adb.run(['-s', serial, 'emu', 'avd', 'name'], 2000).catch(() => '');
    return [serial, name.split(/\r?\n/)[0].trim()];
  }));
}
async function runningAvd(adb: Adb, name: string): Promise<string | undefined> {
  return (await emulatorNames(adb)).find(([, avd]) => avd === name)?.[0];
}

export async function directEmulatorPid(serial: string, profile: string): Promise<number | undefined> {
  if (!managed) return undefined;
  const base = process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Caches', 'TemporaryItems')
    : process.platform === 'win32' && process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Temp') : undefined;
  if (base) {
    // The emulator publishes its console port, AVD path and command line with its actual QEMU PID.
    // This also lets a new PigPort process reuse the window left running by the previous one.
    const directory = path.join(base, 'avd', 'running');
    const avd = path.join(managed.avdHome, `${profile}.avd`);
    for (const file of await fs.readdir(directory).catch(() => [])) {
      const pid = Number(/^pid_(\d+)\.ini$/.exec(file)?.[1]);
      if (!Number.isSafeInteger(pid) || pid <= 0) continue;
      const lines = (await fs.readFile(path.join(directory, file), 'utf8').catch(() => '')).split(/\r?\n/);
      const cmdline = lines.find((line) => line.startsWith('cmdline='));
      if (!lines.includes(`port.serial=${serial.slice('emulator-'.length)}`) ||
          !lines.includes(`avd.dir=${avd}`) || !cmdline || /\s"?(?:-no-window|-qt-hide-window)"?(?:\s|$)/.test(cmdline)) continue;
      try {
        process.kill(pid, 0);
        return pid;
      } catch { /* stale registration */ }
    }
  }
  const window = directWindows.get(profile);
  const child = window?.serial === serial ? window.child : undefined;
  if (child?.exitCode === null && child.signalCode === null) return child.pid;
}

async function stopEmulator(adb: Adb, serial: string | undefined, child?: ChildProcess): Promise<void> {
  const alive = () => !!child?.pid && child.exitCode === null && child.signalCode === null;
  if (serial) {
    await adb.run(['-s', serial, 'emu', 'kill'], 5000).catch(() => {});
  } else if (child?.pid && alive()) {
    if (process.platform === 'win32') await execute('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { timeout: 5000, windowsHide: true }).catch(() => {});
    else child.kill();
  }
  const deadline = Date.now() + 15000;
  while (alive() || (serial && (await adb.devices()).some((device) => device.serial === serial))) {
    if (Date.now() >= deadline) throw new Error('Android is still shutting down. Wait a moment, then retry.');
    await pause(350);
  }
}

export function directDisplayProfile(resolution: AndroidResolution | undefined, silicon: boolean, memory: number, chip: string) {
  const limitedMemory = silicon && memory <= 8 * 1024 ** 3;
  const suggested = silicon && (limitedMemory || chip === 'Apple M1') ? '800x500' : silicon ? '960x600' : '1280x800';
  const size: DisplaySize = resolution && Object.hasOwn(scales, resolution) ? resolution as DisplaySize : suggested;
  return { size, limitedMemory };
}

async function waitForGooglePlayNetwork(adb: Adb, serial: string): Promise<void> {
  // The package manager can be ready before Wi-Fi and DNS on a fresh Google Play boot.
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const status = await adb.shell(serial, ['dumpsys', 'connectivity'], 1500).catch(() => '');
    const network = /^Active default network: (\d+)\s*$/m.exec(status)?.[1];
    if (network && status.split('\n').some((line) =>
      line.includes(`NetworkAgentInfo{network{${network}}`) && /\bVALIDATED\b/.test(line))) return;
    await pause(500);
  }
}

async function startAvd(adb: Adb, name: string, graphics: AndroidGraphics, { mode, resolution, progress }: StartOptions): Promise<string> {
  const builtin = managed?.profiles.includes(name) ?? false;
  if (mode && !builtin) throw new Error('Set up built-in Android from Game library, then retry.');
  const running = await runningAvd(adb, name);
  const known = directWindows.get(name);
  const window = known?.serial === running ? known : undefined;
  if (builtin && !window) directWindows.delete(name);
  const visible = builtin && running && mode ? await directEmulatorPid(running, name) : undefined;
  const direct = mode === 'direct' || (mode === 'restart' && !!visible);
  if (running && mode !== 'restart' && (!direct || visible)) {
    await waitForAndroid(adb, running);
    return running;
  }
  if (running) {
    progress?.('Switching the built-in Android window…');
    await stopEmulator(adb, running, window?.child);
  }

  const profile = directDisplayProfile(resolution, appleSilicon, os.totalmem(), os.cpus()[0]?.model.trim() ?? '');
  const avd = builtin && managed ? path.join(managed.avdHome, `${name}.avd`) : undefined;
  const angle = direct && appleSilicon && graphics === 'auto';
  const attempts: { renderer: AndroidGraphics; angle: boolean; cold?: boolean }[] = [{ renderer: graphics, angle }];
  if (angle) attempts.push({ renderer: 'opengl', angle: false });
  if (direct && graphics !== 'software') attempts.push({ renderer: 'software', angle: false });
  const failures: string[] = [];
  for (const [index, attempt] of attempts.entries()) {
    // Guest ANGLE uses Vulkan for Android's own UI, which prevents snapshot saving.
    const quickBootProfile = direct && appleSilicon && graphics === 'opengl' && attempt.renderer === 'opengl'
      ? `opengl:${profile.size}:${profile.limitedMemory}` : undefined;
    const quickBoot = avd ? await prepareQuickBoot(avd,
      quickBootProfile, mode !== 'restart' && !attempt.cold) : 'off';
    const gpu = attempt.angle ? 'ANGLE' : attempt.renderer === 'software' ? 'SwiftShader' : direct ? 'hardware graphics' : 'automatic graphics';
    progress?.(`${quickBoot === 'restore' ? 'Restoring' : failures.length ? 'Retrying' : 'Starting'} Android with ${gpu}…`);
    const args = emulatorArguments(name, builtin, attempt.renderer, direct, { ...profile, angle: attempt.angle, quickBoot });
    const child = spawn(sdkTool('emulator', 'emulator')!, args,
      { detached: true, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: emulatorEnv() });
    const output = new TextTail(4096);
    child.stdout?.on('data', (bytes) => output.append(bytes));
    child.stderr?.on('data', (bytes) => output.append(bytes));
    let failed: string | undefined;
    child.on('error', (error) => { failed = error.message; });
    child.on('exit', (code, signal) => {
      // On Windows, a successful launcher exit can leave QEMU booting in its own process.
      if (code !== 0 || process.platform !== 'win32') failed = `Emulator exited (${code ?? signal}).`;
    });
    child.unref();

    let serial: string | undefined;
    let interval = 350;
    const deadline = Date.now() + (quickBoot === 'restore' ? 45000 : 180000);
    try {
      while (!failed && Date.now() < deadline) {
        serial ??= await runningAvd(adb, name);
        if (serial && await androidIsReady(adb, serial) && !failed) {
          if (name === GOOGLE_PLAY_AVD) await waitForGooglePlayNetwork(adb, serial);
          if (failed) throw new Error(failed);
          if (direct) directWindows.set(name, { serial, child });
          return serial;
        }
        await pause(Math.min(interval, Math.max(1, deadline - Date.now())));
        interval = Math.min(1500, interval + 250);
      }
      throw new Error(failed ?? (quickBoot === 'restore' ? 'Android could not resume the snapshot.' : 'Android did not finish booting within 3 minutes.'));
    } catch (error) {
      const log = output.text().trim();
      failures.push(`${gpu}: ${(error as Error).message}\n${log}`);
      const locked = /multiple emulators with the same avd|another emulator instance.*running/i.test(log);
      await stopEmulator(adb, locked ? undefined : serial ?? await runningAvd(adb, name).catch(() => undefined), child);
      if (locked || /no space left on device|not enough (?:free )?disk space|insufficient disk space/i.test(log)) break;
      if (profile.size !== '1280x800' && /(?:unknown|unrecognized|invalid) option[^\r\n]*lcd-scaling-factor/i.test(log)) {
        profile.size = '1280x800';
        attempts.splice(index + 1, 0, { ...attempt, cold: true });
      } else if (quickBoot === 'restore') {
        attempts.splice(index + 1, 0, { ...attempt, cold: true });
      }
    }
  }
  throw new Error(`Could not start the Android virtual device.\n${failures.join('\n\n')}`);
}

export function emulatorArguments(name: string, managed: boolean, graphics: AndroidGraphics, direct = false, options: EmulatorOptions = {}): string[] {
  const args = ['-avd', name, '-no-boot-anim'];
  if (!managed) return args;
  const gpu = graphics === 'software' ? 'swiftshader' : direct || graphics === 'opengl' ? 'host' : 'auto';
  const size = options.size ?? '1280x800';
  args.push('-partition-size', '32768', '-gpu', gpu, '-skin', direct ? size : '1280x800');
  if (!direct) args.push('-no-window');
  if (direct && size !== '1280x800') args.push('-lcd-scaling-factor', String(scales[size]));
  if (direct && options.limitedMemory) args.push('-memory', '2560', '-cores', '3');
  if (direct && options.angle) args.push('-feature', 'GuestAngle');
  if (!direct || !options.quickBoot || options.quickBoot === 'off') args.push('-no-snapshot');
  else if (options.quickBoot === 'cold') args.push('-no-snapshot-load');
  return args;
}
