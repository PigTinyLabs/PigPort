import type { Adb } from './adb';
export const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
export function packageId(value: string): string {
  if (!/^[A-Za-z][\w]*(?:\.[A-Za-z][\w]*)+$/.test(value)) throw new Error('Invalid Android package ID.');
  return value;
}
export function normalizeAbi(abi: string): string {
  return ({ arm64_v8a: 'arm64-v8a', armeabi_v7a: 'armeabi-v7a' } as Record<string, string>)[abi] ?? abi;
}
export async function assertAbi(adb: Adb, serial: string, required: string[]): Promise<void> {
  if (!required.length) return;
  const supported = (await adb.shell(serial, ['getprop', 'ro.product.cpu.abilist'], 10000)).trim().split(',').map(normalizeAbi);
  if (!supported.some((s) => required.map(normalizeAbi).includes(s))) {
    throw new Error(`Game CPU ABI (${required.join(', ')}) does not match Android (${supported.join(', ') || 'unknown'}). Use a matching system image; tablet/device-name settings cannot translate CPU instructions.`);
  }
}
export async function waitForAndroid(adb: Adb, serial: string, timeout = 90000): Promise<void> {
  const deadline = Date.now() + timeout;
  do {
    const booted = (await adb.shell(serial, ['getprop', 'sys.boot_completed'], 5000).catch(() => '')).trim() === '1';
    if (booted && /package:/.test(await adb.shell(serial, ['pm', 'path', 'android'], 5000).catch(() => ''))) return;
    if (Date.now() >= deadline) break;
    await pause(Math.min(1000, Math.max(1, deadline - Date.now())));
  } while (Date.now() < deadline);
  throw new Error('Android is connected but has not finished booting or its package manager is unavailable. Wait and retry.');
}
export function launchComponent(output: string, pkg: string): string {
  packageId(pkg);
  const component = output.trim().split(/\r?\n/).reverse().find((line) => line.startsWith(pkg + '/') && /^[\w.$]+\/[\w.$]+$/.test(line));
  if (!component) throw new Error(`${pkg} has no available launcher activity. Check that all APK splits are installed.`);
  return component;
}
export class TextTail {
  private data = Buffer.alloc(0);
  constructor(private bytes = 65536) {}
  append(chunk: Buffer | string): void { this.data = Buffer.concat([this.data, Buffer.from(chunk)]).subarray(-this.bytes); }
  text(): string { return this.data.toString('utf8'); }
}
