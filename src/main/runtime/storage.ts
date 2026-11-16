import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const runtimeFolders = ['ios', path.join('runtime', 'android')];

export async function moveGameStorage(
  sourceRoot: string,
  selectedFolder: string,
  prepare: (staging: string, destination: string) => Promise<void>,
  activate: (destination: string) => Promise<void>,
  progress: (message: string) => void,
): Promise<{ path: string; remaining: string[] }> {
  const source = await fs.realpath(sourceRoot);
  const sourceIdentity = await fs.stat(source);
  const parent = await fs.realpath(selectedFolder);
  const destination = path.join(parent, 'PigPort Data');
  if (/[\r\n]/.test(destination)) throw new Error('Choose a folder whose path does not contain line breaks.');
  if (destination === source) return { path: sourceRoot, remaining: [] };
  const relative = path.relative(source, destination);
  if (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`)) {
    throw new Error('Choose a folder outside the current PigPort data folder.');
  }
  try {
    await fs.lstat(destination);
    throw new Error('This folder already contains PigPort Data. Choose a different folder.');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const staging = await fs.mkdtemp(path.join(parent, '.pigport-moving-'));
  let published = false;
  const copied: string[] = [];
  try {
    for (const folder of runtimeFolders) {
      const from = path.join(source, folder);
      const folderStat = await fs.lstat(from).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
        return undefined;
      });
      if (!folderStat) continue;
      if (!folderStat.isDirectory()) throw new Error(`Expected a PigPort data directory at ${from}.`);
      const to = path.join(staging, folder);
      await fs.mkdir(path.dirname(to), { recursive: true });
      progress(`Copying ${folder === 'ios' ? 'iOS games and saved data' : 'built-in Android and saved data'}…`);
      if (process.platform === 'darwin') await execute('/usr/bin/ditto', [from, to]);
      else await fs.cp(from, to, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
      copied.push(from);
    }
    await prepare(staging, destination);
    await fs.rename(staging, destination);
    published = true;
    await activate(destination);
  } catch (error) {
    await fs.rm(published ? destination : staging, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }

  const remaining: string[] = [];
  // Preserve the original if either drive disappeared or was remounted during the move.
  const currentSource = await fs.stat(source).catch(() => undefined);
  if (currentSource?.dev !== sourceIdentity.dev || currentSource.ino !== sourceIdentity.ino ||
      !await fs.stat(destination).then(() => true, () => false)) {
    return { path: destination, remaining: copied };
  }
  for (const from of copied) {
    await fs.rm(from, { recursive: true, force: true }).catch(() => { remaining.push(from); });
  }
  return { path: destination, remaining };
}
