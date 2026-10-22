import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { plistMetadata } from '../packages/plist';
const execute = promisify(execFile);

/** Sign known converted Mach-O files and executable bundles, inside out.
 * Resource-only .bundle directories are sealed by their enclosing code bundle.
 */
export async function signAppCode(root: string, binaries: ReadonlySet<string>): Promise<void> {
  const sign = (target: string) => execute('/usr/bin/codesign', ['--force', '--sign', '-', target], { timeout: 300000 });
  const executable = async (bundle: string): Promise<string | undefined> => {
    for (const location of ['Contents/Info.plist', 'Info.plist']) {
      const bytes = await fs.readFile(path.join(bundle, location)).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return undefined;
        throw error;
      });
      if (!bytes) continue;
      const name = plistMetadata(bytes).CFBundleExecutable;
      if (typeof name !== 'string' || !name || name !== path.basename(name) || /[\\/:]/.test(name) || name === '.' || name === '..') return undefined;
      return path.join(bundle, location.startsWith('Contents/') ? 'Contents/MacOS' : '', name);
    }
    return undefined;
  };
  const visit = async (dir: string): Promise<void> => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      // The installer creates one controlled Frameworks symlink. Never follow it twice.
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await visit(full);
        if (/\.(framework|bundle|app|xpc|appex)$/.test(entry.name)) {
          const main = await executable(full);
          if (main && binaries.has(main)) await sign(full);
        }
      } else if (entry.isFile() && binaries.has(full)) await sign(full);
    }
  };
  await visit(root);
  // All nested executable code has its own signature; do not reclassify resource
  // bundles as executable code through recursive --deep signing.
  await sign(root);
  await execute('/usr/bin/codesign', ['--verify', '--deep', '--strict', root], { timeout: 120000 });
}
