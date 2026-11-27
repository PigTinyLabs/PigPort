import { promises as fs } from 'node:fs';
import path from 'node:path';

export type QuickBoot = 'off' | 'cold' | 'restore';

export async function prepareQuickBoot(avd: string, profile?: string, allowRestore = true): Promise<QuickBoot> {
  const marker = path.join(avd, 'pigport-quick-boot.json');
  const previous = await fs.readFile(marker, 'utf8')
    .then((data) => JSON.parse(data) as { profile?: string }).catch(() => undefined);
  const lastStart = await fs.stat(marker).catch(() => undefined);

  // Every launch consumes the previous marker. A headless run, failed boot or crash
  // can leave an older snapshot behind even when the Android disk has newer saves.
  await fs.rm(marker, { force: true });
  if (!profile) return 'off';

  const disk = await fs.statfs(avd).catch(() => undefined);
  if (!disk || disk.bavail * disk.bsize < 5 * 1024 ** 3) return 'off';
  const snapshot = path.join(avd, 'snapshots', 'default_boot');
  const [metadata, ...ram] = await Promise.all(['snapshot.pb', 'ram.bin', 'ram.img'].map(
    (name) => fs.stat(path.join(snapshot, name)).catch(() => undefined),
  ));
  const newestRam = ram.some((file) => file && file.size > 0 && lastStart && file.mtimeMs > lastStart.mtimeMs);
  const canRestore = allowRestore && previous?.profile === profile && lastStart
    && metadata && metadata.size > 0 && metadata.mtimeMs > lastStart.mtimeMs && newestRam;

  try { await fs.writeFile(marker, JSON.stringify({ profile })); }
  catch { return 'off'; }
  return canRestore ? 'restore' : 'cold';
}
