import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { inspectArchive, ArchiveEntry, validateLocalEntries } from '../packages/archive';
import { iosAppsSupported } from '../mac/iosApps';
import { convertMachFile } from './macho';
import { signAppCode } from './signing';
import { patchAntiCheat } from './anticheat';
const execute = promisify(execFile);
type Progress = (message: string) => void;

export function validateIpaEntries(entries: ReadonlyMap<string, ArchiveEntry>): void {
  let total = 0;
  const normalized = new Set<string>();
  for (const [name, e] of entries) {
    const segments = name.replace(/\/$/, '').split('/');
    if (!name || name.includes('\\') || /[\x00-\x1f:]/.test(name) || segments.some((p) => !p || p === '.' || p === '..')) throw new Error('Unsafe path in IPA archive.');
    if ((e.mode & 0xf000) === 0xa000) throw new Error('IPA archives containing symbolic links are not supported.');
    const key = name.replace(/\/$/, '').normalize('NFC').toLowerCase();
    if (normalized.has(key)) throw new Error('IPA contains conflicting file paths.');
    normalized.add(key); total += e.size;
    if (total > 16 * 1024 ** 3) throw new Error('Unpacked IPA exceeds the 16 GiB installation limit.');
  }
}

export class NativeIpaRuntime {
  constructor(private root: string, private progress: Progress = () => undefined) {}
  async available(): Promise<boolean> {
    if (!iosAppsSupported()) return false;
    return fs.access('/System/iOSSupport/System/Library/Frameworks/UIKit.framework').then(() => true, () => false);
  }
  async install(file: string, bundleId: string): Promise<string> {
    if (!await this.available()) throw new Error('Direct IPA installation requires macOS Apple Silicon with the Apple iOSSupport frameworks.');
    if (!/^[a-zA-Z0-9][a-zA-Z0-9.-]+$/.test(bundleId) || bundleId.includes('..')) throw new Error('Invalid IPA bundle identifier.');
    const apps = path.join(this.root, 'Applications'); await fs.mkdir(apps, { recursive: true });
    const stage = await fs.mkdtemp(path.join(this.root, 'install-'));
    const target = path.join(apps, bundleId + '.app'), backup = target + '.previous-' + randomUUID();
    let backedUp = false;
    try {
      const snapshot = path.join(stage, 'package.ipa');
      await fs.copyFile(file, snapshot);
      this.progress('Checking IPA archive…');
      await inspectArchive(snapshot, async (_names, _read, entries) => { validateIpaEntries(entries); await validateLocalEntries(snapshot, entries); });
      this.progress('Extracting IPA…');
      const extracted = path.join(stage, 'unpacked');
      await execute('/usr/bin/ditto', ['-x', '-k', snapshot, extracted], { timeout: 600000 });
      const payload = path.join(extracted, 'Payload');
      const candidates = (await fs.readdir(payload)).filter((n) => n.endsWith('.app'));
      if (candidates.length !== 1) throw new Error('Expected exactly one app in IPA Payload.');
      const original = path.join(payload, candidates[0]), originalPlist = path.join(original, 'Info.plist');
      const get = async (key: string) => (await execute('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', originalPlist])).stdout.trim();
      if (await get('CFBundleIdentifier') !== bundleId) throw new Error('IPA identity changed during installation.');
      const executable = await get('CFBundleExecutable');
      if (!executable || executable !== path.basename(executable) || /[\\/:]/.test(executable) || executable === '.' || executable === '..') throw new Error('Invalid app executable name.');
      // Keep the iOS flat layout (executable and resources at the bundle root):
      // engines and SDKs locate files next to the executable or at bundlePath.
      this.progress('Neutralizing anti-cheat modules…');
      await patchAntiCheat(original);
      this.progress('Converting iOS binaries for Mac Catalyst…');
      const converted = new Set<string>();
      const patchTree = async (dir: string): Promise<void> => {
        for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isSymbolicLink()) throw new Error('Unexpected symlink in extracted app.');
          if (entry.isDirectory()) {
            if (entry.name === '_CodeSignature' || entry.name === 'SC_Info' || entry.name === 'PlugIns' || entry.name === 'Watch') {
              // iOS extensions cannot be loaded as desktop processes.
              await fs.rm(full, { recursive: true }); continue;
            }
            await patchTree(full);
          } else if (entry.isFile() && await convertMachFile(full, full === path.join(original, executable))) converted.add(path.relative(original, full));
        }
      };
      await patchTree(original);
      if (!converted.size) throw new Error('No compatible iOS executable found.');
      await fs.rm(path.join(original, 'embedded.mobileprovision'), { force: true });
      await fs.chmod(path.join(original, executable), 0o755);
      const set = async (key: string, value: unknown) => execute('/usr/bin/plutil', ['-replace', key, '-json', JSON.stringify(value), originalPlist]);
      await set('CFBundleSupportedPlatforms', ['MacOSX']); await set('LSRequiresIPhoneOS', false);
      await set('LSMinimumSystemVersion', '12.0'); await set('NSHighResolutionCapable', true);
      await set('LSApplicationCategoryType', 'public.app-category.games');
      this.progress('Signing and verifying game…');
      const built = path.join(stage, 'Game.app');
      await fs.rename(original, built);
      await signAppCode(built, new Set([...converted].map((relative) => path.join(built, relative))));
      if (await fs.stat(target).catch(() => undefined)) { await fs.rename(target, backup); backedUp = true; }
      try { await fs.rename(built, target); }
      catch (e) { if (backedUp) { await fs.rename(backup, target); backedUp = false; } throw e; }
      if (backedUp) await fs.rm(backup, { recursive: true, force: true }).catch(() => undefined);
      return target;
    } finally { await fs.rm(stage, { recursive: true, force: true }); }
  }
  async find(bundleId: string): Promise<string | undefined> {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9.-]+$/.test(bundleId) || bundleId.includes('..')) return undefined;
    const target = path.join(this.root, 'Applications', bundleId + '.app');
    return fs.access(target).then(() => target, () => undefined);
  }
  /** iOS apps live under /var (really /private/var), and engines such as NetEase NeoX
   * prefix app and home paths with "/private". Launch from an APFS clone in the per-user
   * cache folder, whose real path starts with /private, with a home linked from there. */
  async launch(bundleId: string, input?: { library: string; keymap: string; deviceType?: 'ipad' | 'iphone' }): Promise<void> {
    const target = await this.find(bundleId);
    if (!target) throw new Error('Game is not installed. Install the IPA again.');
    if (!await fs.access(path.join(target, 'Info.plist')).then(() => true, () => false)) throw new Error('This game was installed by an older version of PigPort. Click Reinstall.');
    const { clone, home } = await this.runPaths(bundleId);
    await fs.mkdir(path.dirname(clone), { recursive: true, mode: 0o700 }); await fs.mkdir(path.dirname(home), { recursive: true, mode: 0o700 });
    const stampFile = clone + '.stamp';
    const seal = await fs.stat(path.join(target, '_CodeSignature', 'CodeResources'));
    const stamp = `${target}:${seal.ino}:${seal.mtimeMs}`;
    if (await fs.readFile(stampFile, 'utf8').catch(() => '') !== stamp || !await fs.access(clone).then(() => true, () => false)) {
      // Clones share storage with the installed game, so this is fast and uses no extra space.
      const temp = clone + '.cloning-' + randomUUID();
      try {
        await execute('/bin/cp', ['-c', '-R', target, temp], { timeout: 300000 });
        await fs.rm(clone, { recursive: true, force: true }); await fs.rename(temp, clone);
      } finally { await fs.rm(temp, { recursive: true, force: true }); }
      await fs.writeFile(stampFile, stamp);
    }
    // Game data stays in PlayBridge's data folder instead of the user's ~/Documents.
    const data = this.dataPath(bundleId);
    for (const dir of ['Documents', 'Library/Caches', 'Library/Application Support', 'tmp']) await fs.mkdir(path.join(data, dir), { recursive: true });
    if (await fs.readlink(home).catch(() => undefined) !== data) { await fs.rm(home, { force: true }); await fs.symlink(data, home); }
    const env = ['CFFIXED_USER_HOME=' + home];
    if (process.env.PLAYBRIDGE_DEVICE_TYPE) env.push('PLAYBRIDGE_DEVICE_TYPE=' + process.env.PLAYBRIDGE_DEVICE_TYPE);
    // Keyboard/mouse controls and device spoofing: the input layer unsets these variables as soon as it loads.
    if (input && !input.library.includes(':')) {
      env.push('DYLD_INSERT_LIBRARIES=' + input.library, 'PLAYBRIDGE_KEYMAP=' + input.keymap);
      if (input.deviceType) env.push('PLAYBRIDGE_DEVICE_TYPE=' + input.deviceType);
    }
    await execute('/usr/bin/open', ['-n', ...env.flatMap((v) => ['--env', v]), clone], { timeout: 15000 });
  }

  /** Bytes used by the game's saved data, patches and caches. */
  async dataSize(bundleId: string): Promise<number> {
    const out = await execute('/usr/bin/du', ['-sk', this.dataPath(bundleId)]).then((r) => r.stdout, () => '0');
    return (parseInt(out, 10) || 0) * 1024;
  }

  /** Removes the installed game and its launch copy; game data only when asked. */
  async uninstall(bundleId: string, removeData: boolean): Promise<void> {
    const target = await this.find(bundleId);
    const { clone, home } = await this.runPaths(bundleId);
    const processes = (await execute('/bin/ps', ['-wwaxo', 'args='], { maxBuffer: 16 * 1024 * 1024 })).stdout.split('\n');
    if (processes.some((p) => p.startsWith(clone + '/') || (target && p.startsWith(target + '/')))) throw new Error('Quit the game before uninstalling it.');
    for (const item of [clone, clone + '.stamp', home, ...(target ? [target] : [])]) await fs.rm(item, { recursive: true, force: true });
    if (removeData) await fs.rm(this.dataPath(bundleId), { recursive: true, force: true });
  }

  private dataPath(bundleId: string): string {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9.-]+$/.test(bundleId) || bundleId.includes('..')) throw new Error('Invalid IPA bundle identifier.');
    return path.join(this.root, 'Containers', bundleId);
  }

  private async runPaths(bundleId: string): Promise<{ clone: string; home: string }> {
    const cache = (await execute('/usr/bin/getconf', ['DARWIN_USER_CACHE_DIR'])).stdout.trim();
    if (!path.isAbsolute(cache)) throw new Error('Could not locate the macOS user cache folder.');
    const run = path.join(await fs.realpath(cache), 'io.playbridge.ios');
    return { clone: path.join(run, 'Applications', bundleId + '.app'), home: path.join(run, 'Homes', bundleId) };
  }
}
