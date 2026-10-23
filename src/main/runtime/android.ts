import { existsSync } from 'node:fs';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { Adb } from '../android/adb';
import { TextTail, waitForAndroid } from '../android/health';
const execute = promisify(execFile);
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const booting = new Map<string, Promise<string>>();
let managed: { sdk: string; avdHome: string } | undefined;
export function configureManagedAndroid(sdk: string, avdHome: string): void { managed = { sdk, avdHome }; }
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
export async function ensureAndroid(adb: Adb, serial?: string, preferredAvd?: string, graphics: 'auto' | 'software' = 'auto', forceAvd = false): Promise<string> {
  const devices = await adb.devices();
  const ready = devices.filter((d) => d.state === 'device');
  if (serial) {
    if (!ready.some((d) => d.serial === serial)) throw new Error('Selected Android device disconnected. Refresh devices and retry.');
    await waitForAndroid(adb, serial);
    return serial;
  }
  if (!forceAvd && ready.length > 1) throw new Error('Choose the Android device to install on in the sidebar.');
  if (!forceAvd && ready.length === 1) { await waitForAndroid(adb, ready[0].serial); return ready[0].serial; }
  if (!forceAvd && devices.some((d) => d.state === 'unauthorized')) throw new Error('Allow USB debugging on the connected phone, then retry.');
  const names = await avds();
  const name = preferredAvd || (names.length === 1 ? names[0] : undefined);
  if (!name || !names.includes(name)) throw new Error(names.length
    ? 'Choose an Android virtual device in Settings, then retry.'
    : 'Set up built-in Android from Game library, then retry.');
  const existing = booting.get(name);
  if (existing) return existing;
  const task = (async (): Promise<string> => {
    const child = spawn(sdkTool('emulator', 'emulator')!, emulatorArguments(name, !!managed, graphics),
      { detached: true, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: emulatorEnv() });
    const output = new TextTail();
    child.stdout?.on('data', (bytes) => output.append(bytes));
    child.stderr?.on('data', (bytes) => output.append(bytes));
    let failed: string | undefined;
    child.on('error', (e) => { failed = e.message; });
    child.on('exit', (code) => { failed = `Android emulator exited (${code}). Check virtualization support and available memory, then retry.`; });
    child.unref();
    const deadline = Date.now() + 180000;
    while (Date.now() < deadline) {
      if (failed) throw new Error(failed + '\n' + output.text());
      for (const device of (await adb.devices()).filter((d) => d.serial.startsWith('emulator-') && d.state === 'device')) {
        const runningName = await adb.run(['-s', device.serial, 'emu', 'avd', 'name'], 5000).catch(() => '');
        if (runningName.split(/\r?\n/)[0].trim() !== name) continue;
        if ((await adb.shell(device.serial, ['getprop', 'sys.boot_completed'], 5000).catch(() => '')).trim() === '1') { await waitForAndroid(adb, device.serial, Math.max(1, deadline - Date.now())); return device.serial; }
      }
      await delay(1500);
    }
    throw new Error('Android did not finish booting within 3 minutes. Check its window and retry.');
  })().finally(() => booting.delete(name));
  booting.set(name, task);
  return task;
}

export function emulatorArguments(name: string, managed: boolean, graphics: 'auto' | 'software'): string[] {
  return ['-avd', name, '-no-boot-anim', ...(managed
    ? ['-no-window', '-no-snapshot', '-skin', '1280x800', '-dpi-device', '160', '-partition-size', '32768', '-gpu', graphics === 'software' ? 'swiftshader' : 'auto'] : [])];
}
