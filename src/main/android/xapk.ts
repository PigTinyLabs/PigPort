import path from 'node:path';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Adb } from './adb';
import { inspectArchive } from '../packages/archive';

const execute = promisify(execFile);

/**
 * Installs an XAPK package onto an Android device or emulator.
 * XAPK packages contain base and split APKs along with optional expansion (OBB) files.
 */
export async function installXapk(
  adb: Adb,
  serial: string,
  xapkFile: string,
  bundleId: string,
  onProgress?: (message: string) => void
): Promise<void> {
  const stage = await fs.mkdtemp(path.join(os.tmpdir(), 'pb-xapk-'));
  try {
    onProgress?.('Extracting XAPK archive…');
    await extractZip(xapkFile, stage);

    const allFiles: string[] = [];
    const scanDir = async (dir: string) => {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) await scanDir(full);
        else allFiles.push(full);
      }
    };
    await scanDir(stage);

    const apks = allFiles.filter((f) => f.endsWith('.apk'));
    if (!apks.length) throw new Error('No APK found inside XAPK package.');

    apks.sort((a, b) => {
      const aName = path.basename(a).toLowerCase();
      const bName = path.basename(b).toLowerCase();
      if (aName === 'base.apk' || aName === `${bundleId.toLowerCase()}.apk`) return -1;
      if (bName === 'base.apk' || bName === `${bundleId.toLowerCase()}.apk`) return 1;
      return aName.localeCompare(bName);
    });

    const install = await matchDeviceAbis(adb, serial, apks);
    onProgress?.(`Installing ${install.length > 1 ? `${install.length} split APKs` : 'APK'} on Android…`);
    await adb.install(serial, install);

    const obbs = allFiles.filter((f) => f.endsWith('.obb'));
    if (obbs.length > 0) {
      const remoteObbDir = `/sdcard/Android/obb/${bundleId}`;
      onProgress?.(`Creating Android OBB folder…`);
      await adb.shell(serial, ['mkdir', '-p', remoteObbDir]);

      for (const obb of obbs) {
        const filename = path.basename(obb);
        onProgress?.(`Pushing expansion data (${filename}) to device…`);
        await adb.push(serial, obb, `${remoteObbDir}/${filename}`);
      }
    }
  } finally {
    await fs.rm(stage, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Drops native-code splits the device cannot run, and fails with a readable message instead of
 * INSTALL_FAILED_NO_MATCHING_ABIS when the game ships no ABI the device supports.
 * `apks[0]` is the base APK and is always kept.
 */
export async function matchDeviceAbis(adb: Adb, serial: string, apks: string[]): Promise<string[]> {
  const device = await adb.abis(serial);
  if (!device.length) return apks;
  const native = await Promise.all(apks.map((apk) => inspectArchive(apk, async (names) =>
    [...new Set(names.flatMap((n) => n.match(/^lib\/([^/]+)\//)?.[1] ?? []))]).catch(() => [] as string[])));
  const shipped = [...new Set(native.flat())];
  if (shipped.length && !shipped.some((abi) => device.includes(abi))) {
    throw new Error(`This game only contains ${shipped.join(', ')} native code, but the Android device runs ${device.join(', ')}. `
      + 'Use an environment or device with compatible ARM translation via Connect, or an Android phone.');
  }
  return apks.filter((_, i) => i === 0 || !native[i].length || native[i].some((abi) => device.includes(abi)));
}

/** Windows has no `unzip`; its bundled bsdtar (Windows 10 1803+) reads ZIP/ZIP64 under any extension. */
async function extractZip(zip: string, dest: string): Promise<void> {
  if (process.platform === 'darwin') {
    await execute('/usr/bin/ditto', ['-x', '-k', zip, dest], { timeout: 600000 });
  } else if (process.platform === 'win32') {
    const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
    try {
      await execute(tar, ['-xf', zip, '-C', dest], { timeout: 600000, windowsHide: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      // Expand-Archive rejects non-.zip extensions, so call .NET directly.
      const quote = (s: string) => "'" + s.replace(/'/g, "''") + "'";
      const script = `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::ExtractToDirectory(${quote(zip)}, ${quote(dest)})`;
      await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { timeout: 600000, windowsHide: true });
    }
  } else {
    await execute('unzip', ['-q', '-o', zip, '-d', dest], { timeout: 600000 });
  }
}
