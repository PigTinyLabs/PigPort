import { execFileSync } from 'node:child_process';
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const architectures = {
  'aarch64-apple-darwin': 'mac-arm64',
  'x86_64-apple-darwin': 'mac-x64',
  'x86_64-pc-windows-msvc': 'win-x64',
};
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = process.argv[2];
if (!Object.hasOwn(architectures, target)) throw new Error(`Unknown PigPort release target: ${target}`);
const platform = architectures[target];
const { productName, version } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const buildDir = path.join(root, 'src-tauri', 'target', target, 'release');
const releaseDir = path.join(root, 'release');
const outputName = `${productName}-${version}-${platform}`;

function copyInstaller(kind, extension) {
  const directory = path.join(buildDir, 'bundle', kind);
  const installers = readdirSync(directory).filter((name) => name.startsWith(`${productName}_${version}_`) && name.endsWith(extension));
  if (installers.length !== 1) throw new Error(`Expected one ${version} ${kind} installer in ${directory}.`);
  copyFileSync(path.join(directory, installers[0]), path.join(releaseDir, outputName + extension));
}

mkdirSync(releaseDir, { recursive: true });
const zip = path.join(releaseDir, outputName + '.zip');
if (platform.startsWith('mac-')) {
  const app = path.join(buildDir, 'bundle', 'macos', `${productName}.app`);
  copyInstaller('dmg', '.dmg');
  execFileSync('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, zip], { stdio: 'inherit' });
} else {
  copyInstaller('nsis', '.exe');
  const stage = mkdtempSync(path.join(os.tmpdir(), 'pigport-release-'));
  try {
    const app = path.join(stage, productName);
    mkdirSync(app);
    copyFileSync(path.join(buildDir, 'pigport.exe'), path.join(app, `${productName}.exe`));
    copyFileSync(path.join(buildDir, 'pigport-worker.exe'), path.join(app, 'pigport-worker.exe'));
    cpSync(path.join(buildDir, 'runtime-assets'), path.join(app, 'runtime-assets'), { recursive: true });
    execFileSync('tar.exe', ['-a', '-c', '-f', zip, '-C', stage, productName], { stdio: 'inherit' });
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}
console.log(`Staged ${outputName} installers and ZIP.`);
