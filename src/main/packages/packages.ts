import path from 'node:path';
import { stat } from 'node:fs/promises';
import { inspectArchive } from './archive';
import { plistMetadata } from './plist';
import { androidMetadata } from './manifest';
import type { MobilePackage } from '../../shared/api';

export async function inspectPackage(file: string): Promise<MobilePackage> {
  const kind = path.extname(file).slice(1).toLowerCase();
  if (kind !== 'ipa' && kind !== 'apk' && kind !== 'xapk') throw new Error('Choose an IPA, APK, or XAPK file');
  const size = (await stat(file)).size;
  return inspectArchive(file, async (names, read) => {
    const base = { kind: kind as 'ipa' | 'apk' | 'xapk', name: path.basename(file), size, file };
    if (kind === 'xapk') {
      let bundleId: string | undefined;
      let name: string = path.basename(file, '.xapk');
      let version: string | undefined;
      let architectures: string[] = [];

      if (names.includes('manifest.json')) {
        try {
          const raw = await read('manifest.json');
          const json = JSON.parse(raw.toString('utf8'));
          bundleId = json.package_name;
          if (json.name) name = json.name;
          version = json.version_name || (json.version_code ? String(json.version_code) : undefined);
          if (Array.isArray(json.split_apks)) {
            architectures = json.split_apks
              .map((s: { id?: string }) => s.id?.replace(/^config\./, ''))
              .filter((id?: string): id is string => Boolean(id && ['arm', 'x86'].some((arch) => id.includes(arch))));
          }
        } catch {}
      }

      if (!bundleId) {
        const obbMatch = names.find((n) => n.startsWith('Android/obb/'))?.match(/^Android\/obb\/([^/]+)/);
        if (obbMatch) bundleId = obbMatch[1];
        else {
          const apkName = names.find((n) => /^[a-zA-Z0-9_.]+\.apk$/i.test(n) && n !== 'base.apk');
          if (apkName) bundleId = path.basename(apkName, '.apk');
        }
      }

      const hasObb = names.some((n) => n.endsWith('.obb'));
      const apkCount = names.filter((n) => n.endsWith('.apk')).length;

      return {
        ...base,
        name,
        bundleId,
        version,
        architectures,
        note: `XAPK with ${apkCount} APK${apkCount > 1 ? 's' : ''}${hasObb ? ' and OBB data' : ''}. Installs automatically on Android device or emulator.`
      };
    }
    if (kind === 'apk') {
      if (!names.includes('AndroidManifest.xml')) throw new Error('APK has no AndroidManifest.xml');
      const manifest = await read('AndroidManifest.xml');
      if (manifest.length < 8) throw new Error('Invalid Android manifest');
      return { ...base, ...androidMetadata(manifest), kind, architectures: [...new Set(names.flatMap((n) => n.match(/^lib\/([^/]+)\//)?.[1] ?? []))],
        note: 'Install on a connected Android emulator or phone. Native library ABIs must match its runtime.' };
    }
    const plists = names.filter((n) => /^Payload\/[^/]+\.app\/Info\.plist$/.test(n));
    if (plists.length !== 1) throw new Error('IPA must contain exactly one Payload/*.app/Info.plist');
    const meta = plistMetadata(await read(plists[0]));
    const string = (key: string) => typeof meta[key] === 'string' ? meta[key] as string : undefined;
    const bundleId = string('CFBundleIdentifier');
    if (!bundleId) throw new Error('IPA has no bundle identifier');
    return { ...base, kind, name: string('CFBundleDisplayName') ?? string('CFBundleName') ?? base.name,
      bundleId, version: string('CFBundleShortVersionString'), minimumOS: string('MinimumOSVersion'), architectures: [],
      note: 'Direct IPA installation requires Apple Silicon macOS and an unencrypted arm64 IPA. The built-in converter is experimental; inspection does not prove game compatibility. Windows cannot run IPA locally.' };
  });
}
