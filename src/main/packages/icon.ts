import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { inspectArchive } from './archive';

const execute = promisify(execFile);

/**
 * Extracts and caches the game icon from an installed app bundle, IPA archive, or APK archive.
 * Re-encodes iOS CgBI-crushed PNGs via sips so that Electron's renderer can display them.
 */
export async function packageIcon(file: string, cacheDir: string, installedPath?: string): Promise<string | undefined> {
  await fs.mkdir(cacheDir, { recursive: true });
  const hash = createHash('sha256').update(installedPath || file).digest('hex').slice(0, 16);
  const cachedFile = path.join(cacheDir, `pkg_${hash}.png`);

  try {
    const cached = await fs.readFile(cachedFile);
    if (cached.length > 0) return `data:image/png;base64,${cached.toString('base64')}`;
  } catch {}

  // 1. If installed iOS bundle exists on disk
  if (installedPath) {
    try {
      const entries = await fs.readdir(installedPath);
      const iconCandidates = entries.filter((f) => /^AppIcon.*\.png$/i.test(f) || /^[Ii]con.*\.png$/i.test(f));
      if (iconCandidates.length > 0) {
        const stats = await Promise.all(
          iconCandidates.map(async (f) => ({ f, size: (await fs.stat(path.join(installedPath, f))).size }))
        );
        const best = stats.sort((a, b) => b.size - a.size)[0].f;
        const src = path.join(installedPath, best);
        if (process.platform === 'darwin') {
          await execute('/usr/bin/sips', ['-s', 'format', 'png', src, '--out', cachedFile]);
          const out = await fs.readFile(cachedFile);
          return `data:image/png;base64,${out.toString('base64')}`;
        } else {
          const out = await fs.readFile(src);
          await fs.writeFile(cachedFile, out);
          return `data:image/png;base64,${out.toString('base64')}`;
        }
      }
    } catch {}
  }

  // 2. Extract from archive (IPA or APK) if the source file exists
  const exists = await fs.access(file).then(() => true, () => false);
  if (!exists) return undefined;

  const ext = path.extname(file).toLowerCase();
  try {
    return await inspectArchive(file, async (names, read) => {
      if (ext === '.ipa') {
        const icons = names.filter((n) => /^Payload\/[^/]+\.app\/.*(AppIcon|Icon)[^/]*\.png$/i.test(n) && !n.includes('__MACOSX'));
        if (!icons.length) {
          const pngs = names.filter((n) => /^Payload\/[^/]+\.app\/[^/]+\.png$/i.test(n) && !n.includes('__MACOSX'));
          if (pngs.length) icons.push(...pngs);
        }
        if (!icons.length) return undefined;

        icons.sort((a, b) => {
          const score = (s: string) =>
            (s.includes('AppIcon') ? 100 : 0) +
            (s.includes('@3x') ? 30 : s.includes('@2x') ? 20 : 0) +
            (s.includes('1024') || s.includes('512') || s.includes('83') || s.includes('76') ? 10 : 0);
          return score(b) - score(a);
        });

        for (const name of icons) {
          try {
            const buf = await read(name);
            if (buf && buf.length > 500) {
              const temp = path.join(cacheDir, `temp_${hash}.png`);
              await fs.writeFile(temp, buf);
              try {
                if (process.platform === 'darwin') {
                  await execute('/usr/bin/sips', ['-s', 'format', 'png', temp, '--out', cachedFile]);
                } else {
                  await fs.copyFile(temp, cachedFile);
                }
                const out = await fs.readFile(cachedFile);
                return `data:image/png;base64,${out.toString('base64')}`;
              } finally {
                await fs.rm(temp, { force: true }).catch(() => undefined);
              }
            }
          } catch {}
        }
      } else if (ext === '.apk') {
        const icons = names.filter((n) => /^res\/(mipmap|drawable)[^/]*\/(ic_launcher|app_icon|icon)[^/]*\.png$/i.test(n));
        if (!icons.length) {
          const anyLauncher = names.filter((n) => n.endsWith('.png') && (n.includes('ic_launcher') || n.includes('app_icon')));
          if (anyLauncher.length) icons.push(...anyLauncher);
        }
        if (!icons.length) return undefined;

        icons.sort((a, b) => {
          const rank = (s: string) => {
            if (s.includes('xxxhdpi')) return 5;
            if (s.includes('xxhdpi')) return 4;
            if (s.includes('xhdpi')) return 3;
            if (s.includes('hdpi')) return 2;
            if (s.includes('mdpi')) return 1;
            return 0;
          };
          return rank(b) - rank(a);
        });

        for (const name of icons) {
          try {
            const buf = await read(name);
            if (buf && buf.length > 500) {
              await fs.writeFile(cachedFile, buf);
              return `data:image/png;base64,${buf.toString('base64')}`;
            }
          } catch {}
        }
      } else if (ext === '.xapk') {
        let iconName: string | undefined;
        if (names.includes('manifest.json')) {
          try {
            const raw = await read('manifest.json');
            const json = JSON.parse(raw.toString('utf8'));
            if (json.icon && names.includes(json.icon)) iconName = json.icon;
          } catch {}
        }
        if (!iconName) {
          iconName = names.find((n) => /^icon\.(png|webp|jpg)$/i.test(n) || /\/icon\.(png|webp|jpg)$/i.test(n) || /app[_-]?icon.*\.(png|webp|jpg)$/i.test(n));
        }
        if (!iconName) {
          iconName = names.find((n) => !n.includes('/') && /\.(png|webp|jpg)$/i.test(n));
        }
        if (iconName) {
          try {
            const buf = await read(iconName);
            if (buf && buf.length > 100) {
              await fs.writeFile(cachedFile, buf);
              const mime = iconName.toLowerCase().endsWith('.webp') ? 'image/webp' : iconName.toLowerCase().endsWith('.jpg') ? 'image/jpeg' : 'image/png';
              return `data:${mime};base64,${buf.toString('base64')}`;
            }
          } catch {}
        }
      }
      return undefined;
    });
  } catch {
    return undefined;
  }
}
