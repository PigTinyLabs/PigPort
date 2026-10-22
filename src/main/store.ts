import { promises as fs } from 'node:fs';
import path from 'node:path';
import { emptyKeymap, Keymap, parseKeymap } from '../shared/keymap';
import type { MobilePackage } from '../shared/api';
import { StreamOptions } from './android/scrcpy';

export interface Settings {
  adbPath?: string;
  androidAvd?: string;
  stream: StreamOptions;
  recentAddresses: string[];
}

const defaults: Settings = {
  stream: { maxSize: 1920, maxFps: 60, bitRate: 8_000_000 },
  recentAddresses: [],
};

export class Store {
  constructor(private dir: string) {}

  async library(): Promise<MobilePackage[]> {
    const value = await this.readJson<MobilePackage[]>('library.json');
    return Array.isArray(value) ? value.map((p) => p.status === 'installing'
      ? { ...p, status: 'error', error: 'Installation was interrupted. Retry installation.' } : p) : [];
  }

  async saveLibrary(packages: MobilePackage[]): Promise<void> {
    await this.writeJson('library.json', packages);
  }

  async settings(): Promise<Settings> {
    const raw = await this.readJson<Partial<Settings>>('settings.json');
    return { ...defaults, ...raw, stream: { ...defaults.stream, ...raw?.stream } };
  }

  async saveSettings(s: Settings): Promise<void> {
    await this.writeJson('settings.json', s);
  }

  async keymap(appId: string): Promise<Keymap> {
    const text = await fs.readFile(this.keymapPath(appId), 'utf8').catch(() => undefined);
    return text ? parseKeymap(text) : emptyKeymap();
  }

  async saveKeymap(appId: string, map: Keymap): Promise<void> {
    // Round-trip through the parser so only valid profiles reach disk.
    const clean = parseKeymap(JSON.stringify(map));
    await fs.mkdir(path.join(this.dir, 'keymaps'), { recursive: true });
    await fs.writeFile(this.keymapPath(appId), JSON.stringify(clean, null, 2));
  }

  keymapPath(appId: string): string {
    return path.join(this.dir, 'keymaps', appId.replace(/[^\w.-]/g, '_') + '.json');
  }

  private async readJson<T>(name: string): Promise<T | undefined> {
    const text = await fs.readFile(path.join(this.dir, name), 'utf8').catch(() => undefined);
    if (!text) return undefined;
    try {
      return JSON.parse(text) as T;
    } catch {
      return undefined;
    }
  }

  private async writeJson(name: string, value: unknown): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    const target = path.join(this.dir, name);
    const temp = target + '.tmp';
    await fs.writeFile(temp, JSON.stringify(value, null, 2));
    await fs.rename(temp, target);
  }
}
