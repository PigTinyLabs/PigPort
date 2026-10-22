// iPhone/iPad apps installed from the Mac App Store on Apple Silicon.
// macOS installs them as wrapper bundles (Name.app/Wrapper/Name.app), which
// is how we tell them apart from ordinary Mac apps. They run natively; we
// only list and launch them.

import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface IosApp {
  name: string;
  bundleId: string;
  path: string;
}

export function iosAppsSupported(): boolean {
  return process.platform === 'darwin' && process.arch === 'arm64';
}

export async function listIosApps(): Promise<IosApp[]> {
  if (!iosAppsSupported()) return [];
  const roots = ['/Applications', path.join(os.homedir(), 'Applications')];
  const apps: IosApp[] = [];
  for (const root of roots) {
    const entries = await fs.readdir(root).catch(() => [] as string[]);
    for (const entry of entries) {
      if (!entry.endsWith('.app')) continue;
      const app = await readWrapped(path.join(root, entry));
      if (app) apps.push(app);
    }
  }
  return apps.sort((a, b) => a.name.localeCompare(b.name));
}

async function readWrapped(appPath: string): Promise<IosApp | undefined> {
  const wrapper = path.join(appPath, 'Wrapper');
  const inner = (await fs.readdir(wrapper).catch(() => [] as string[])).find((e) => e.endsWith('.app'));
  if (!inner) return undefined;
  const plist = path.join(wrapper, inner, 'Info.plist');
  const bundleId = await plistValue(plist, 'CFBundleIdentifier');
  if (!bundleId) return undefined;
  const name = (await plistValue(plist, 'CFBundleDisplayName'))
    ?? (await plistValue(plist, 'CFBundleName'))
    ?? path.basename(appPath, '.app');
  return { name, bundleId, path: appPath };
}

function plistValue(file: string, key: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', file], (err, stdout) => {
      resolve(err ? undefined : stdout.trim() || undefined);
    });
  });
}

/**
 * Icon of a wrapped iOS app as a data URL. Electron's app.getFileIcon crashes
 * on these bundles, so we take the largest AppIcon*.png from the inner app and
 * re-encode it with sips (iOS ships "crushed" PNGs that browsers can't show).
 */
export async function iosAppIcon(appPath: string, cacheDir: string): Promise<string | undefined> {
  const wrapper = path.join(appPath, 'Wrapper');
  const inner = (await fs.readdir(wrapper).catch(() => [] as string[])).find((e) => e.endsWith('.app'));
  if (!inner) return undefined;
  const dir = path.join(wrapper, inner);
  const candidates = (await fs.readdir(dir)).filter((f) => /^AppIcon.*\.png$/i.test(f));
  if (candidates.length === 0) return undefined;
  const sized = await Promise.all(candidates.map(async (f) => ({ f, size: (await fs.stat(path.join(dir, f))).size })));
  const best = sized.sort((a, b) => b.size - a.size)[0].f;

  await fs.mkdir(cacheDir, { recursive: true });
  const out = path.join(cacheDir, `${path.basename(appPath, '.app').replace(/[^\w.-]/g, '_')}.png`);
  await new Promise<void>((resolve, reject) => {
    execFile('/usr/bin/sips', ['-s', 'format', 'png', path.join(dir, best), '--out', out],
      (err) => (err ? reject(err) : resolve()));
  });
  return `data:image/png;base64,${(await fs.readFile(out)).toString('base64')}`;
}

/** Opens the app through LaunchServices, reporting macOS's reason when it refuses. */
export function launchIosApp(appPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/open', [appPath], (err, _stdout, stderr) => {
      if (!err) return resolve();
      const code = stderr.match(/error (-\d+)/)?.[1];
      reject(new Error(`macOS refused to open ${path.basename(appPath, '.app')}` +
        `${code ? ` (LaunchServices error ${code})` : ''}. ` +
        'Try opening it from Finder or Launchpad; if that fails too, delete it and reinstall it from the App Store.'));
    });
  });
}
