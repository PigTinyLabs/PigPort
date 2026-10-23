import path from 'node:path';
import { existsSync, promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { inspectArchive } from './archive';

const execute = promisify(execFile);

function mimeFromBuffer(buf: Buffer): string {
  if (buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf.length >= 12 && buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') return 'image/webp';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  return 'image/png';
}

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
    if (cached.length > 0) return `data:${mimeFromBuffer(cached)};base64,${cached.toString('base64')}`;
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
        const isImage = (n: string) => /\.(png|webp|jpg|jpeg)$/i.test(n);
        const isLauncher = (n: string) => /(ic_launcher|app_icon|game_icon|icon|logo)/i.test(path.basename(n)) &&
          !n.includes('notification') && !n.includes('status') && !n.includes('small');

        let icons = names.filter((n) => isImage(n) && /^res\/(mipmap|drawable)/i.test(n) && isLauncher(n));
        if (!icons.length) {
          icons = names.filter((n) => isImage(n) && isLauncher(n));
        }
        if (!icons.length) {
          icons = names.filter((n) => isImage(n) && /^res\/(mipmap|drawable)/i.test(n));
        }
        if (!icons.length) return undefined;

        icons.sort((a, b) => {
          const rank = (s: string) => {
            let score = 0;
            const lower = s.toLowerCase();
            if (lower.includes('ic_launcher') || lower.includes('app_icon')) score += 100;
            if (lower.includes('round')) score -= 5;
            if (lower.includes('foreground')) score -= 20;
            if (lower.includes('background')) score -= 30;
            if (lower.includes('xxxhdpi')) score += 50;
            else if (lower.includes('xxhdpi')) score += 40;
            else if (lower.includes('xhdpi')) score += 30;
            else if (lower.includes('hdpi')) score += 20;
            else if (lower.includes('mdpi')) score += 10;
            if (lower.endsWith('.png')) score += 2;
            return score;
          };
          return rank(b) - rank(a);
        });

        for (const name of icons) {
          try {
            const buf = await read(name);
            if (buf && buf.length > 50) {
              await fs.writeFile(cachedFile, buf);
              return `data:${mimeFromBuffer(buf)};base64,${buf.toString('base64')}`;
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
            if (buf && buf.length > 50) {
              await fs.writeFile(cachedFile, buf);
              return `data:${mimeFromBuffer(buf)};base64,${buf.toString('base64')}`;
            }
          } catch {}
        }

        // Fallback: If no top-level icon in XAPK, extract the icon from the inner APK!
        const innerApks = names.filter((n) => n.endsWith('.apk'));
        if (innerApks.length > 0) {
          const mainApkName = innerApks.find((n) => n === 'base.apk' || n.toLowerCase().includes('base')) || innerApks[0];
          try {
            const tempDir = path.join(cacheDir, `inner_${hash}`);
            await fs.mkdir(tempDir, { recursive: true });
            if (process.platform === 'darwin' || process.platform === 'linux') {
              await execute('/usr/bin/unzip', ['-j', '-o', file, mainApkName, '-d', tempDir], { timeout: 30000 });
              const extractedApk = path.join(tempDir, path.basename(mainApkName));
              if (existsSync(extractedApk)) {
                try {
                  const innerIcon = await packageIcon(extractedApk, cacheDir);
                  if (innerIcon) {
                    const outBuf = Buffer.from(innerIcon.split(',')[1], 'base64');
                    await fs.writeFile(cachedFile, outBuf);
                    return innerIcon;
                  }
                } finally {
                  await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
                }
              }
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
