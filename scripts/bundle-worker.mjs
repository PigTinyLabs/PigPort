import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const variant = process.argv[2];
if (variant !== undefined && variant !== 'ipa') throw new Error(`Unknown PigPort helper: ${variant}`);
const ipa = variant === 'ipa';
const name = ipa ? 'pigport-ipa-worker' : 'pigport-worker';
const tauri = path.join(root, ...(ipa ? ['ipa-launcher'] : []), 'src-tauri');
const hostTriple = execFileSync('rustc', ['-vV'], { encoding: 'utf8' }).match(/^host: (\S+)/m)?.[1];
const triple = process.env.TAURI_ENV_TARGET_TRIPLE ?? hostTriple;
const targets = {
  'aarch64-apple-darwin': 'darwin-arm64',
  'x86_64-apple-darwin': 'darwin-x64',
  'x86_64-pc-windows-msvc': 'win-x64',
};
const platform = targets[triple];
if (!platform) throw new Error(`PigPort desktop packaging does not support ${triple}.`);
const windows = platform.startsWith('win');
if (ipa && windows) throw new Error('PigPort IPA requires macOS.');
const suffix = windows ? '.exe' : '';
const nodeVersion = process.version;
const working = path.join(root, 'dist', 'desktop', nodeVersion, triple);
const vendorFolder = `node-${nodeVersion}-${platform}`;
const vendorNode = path.join(working, vendorFolder, ...(windows ? ['node.exe'] : ['bin', 'node']));
const archive = `${vendorFolder}${windows ? '.zip' : '.tar.gz'}`;
mkdirSync(working, { recursive: true });

async function download(name) {
  const response = await fetch(`https://nodejs.org/dist/${nodeVersion}/${name}`);
  if (!response.ok) throw new Error(`Could not fetch Node ${name} (HTTP ${response.status}).`);
  return Buffer.from(await response.arrayBuffer());
}

if (!existsSync(vendorNode)) {
  const [checksums, contents] = await Promise.all([download('SHASUMS256.txt'), download(archive)]);
  const checksum = checksums.toString('utf8').split(/\r?\n/).map((line) => line.trim().split(/\s+/))
    .find(([, file]) => file === archive)?.[0];
  if (!checksum || createHash('sha256').update(contents).digest('hex') !== checksum) {
    throw new Error(`Node checksum verification failed for ${archive}.`);
  }
  const downloadPath = path.join(working, archive);
  writeFileSync(downloadPath, contents);
  execFileSync('tar', ['-xf', downloadPath, '-C', working], { stdio: 'inherit' });
  rmSync(downloadPath);
}

const entry = path.join(working, `${name}.cjs`);
await build({
  entryPoints: [path.join(root, 'src/main', ipa ? 'ipaLauncher.ts' : 'main.ts')],
  outfile: entry,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node26',
});
const binaryDir = path.join(tauri, 'binaries');
mkdirSync(binaryDir, { recursive: true });
const output = path.join(binaryDir, `${name}-${triple}${suffix}`);
const config = path.join(working, `${name}.json`);
writeFileSync(config, JSON.stringify({
  main: entry,
  executable: vendorNode,
  output,
  disableExperimentalSEAWarning: true,
  // The packaged macOS helper runs under Hardened Runtime without JIT entitlements.
  execArgv: windows ? [] : ['--jitless'],
  execArgvExtension: 'none',
}));
execFileSync(process.execPath, ['--build-sea', config], { stdio: 'inherit' });
if (!windows) execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', output], { stdio: 'inherit' });

const assets = path.join(tauri, 'runtime-assets');
rmSync(assets, { force: true, recursive: true });
mkdirSync(assets, { recursive: true });
cpSync(path.join(working, vendorFolder, 'LICENSE'), path.join(assets, 'node-LICENSE.txt'));

if (ipa) {
  const ipatoolVersion = '2.8.1';
  const arm = triple === 'aarch64-apple-darwin';
  const asset = `ipatool-${ipatoolVersion}-macos-${arm ? 'arm64' : 'amd64'}`;
  const archivePath = path.join(working, `${asset}.tar.gz`);
  const checksum = arm
    ? '3ad673375ea6bc479df0340df03950c3f6669ab554466b05e4bb99b3369d0dd2'
    : '8d1d93c1f72724cec01e72dab30ecb8eb3faf4c783f71d2310c2db3c7976efbb';
  const verified = (bytes) => createHash('sha256').update(bytes).digest('hex') === checksum;
  if (!existsSync(archivePath) || !verified(readFileSync(archivePath))) {
    const response = await fetch(`https://github.com/majd/ipatool/releases/download/v${ipatoolVersion}/${asset}.tar.gz`);
    if (!response.ok) throw new Error(`Could not fetch IPATool (HTTP ${response.status}).`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!verified(bytes)) throw new Error('IPATool release checksum verification failed.');
    writeFileSync(archivePath, bytes);
  }
  const binary = path.join(binaryDir, `pigport-ipa-ipatool-${triple}`);
  const executable = execFileSync('tar', ['-xOf', archivePath, `bin/${asset}`], { maxBuffer: 128 * 1024 * 1024 });
  writeFileSync(binary, executable, { mode: 0o755 });
  execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', binary], { stdio: 'inherit' });
  cpSync(path.join(root, 'ipa-launcher', 'ipatool-LICENSE.txt'), path.join(assets, 'ipatool-LICENSE.txt'));
}

// Preserve each platform's existing runtime layout in the app bundle.
for (const asset of ipa ? [] : ['scrcpy-server', 'scrcpy-server.version', 'platform-tools', 'ios-input', 'airplay']) {
  const source = path.join(root, 'resources', asset);
  if (existsSync(source)) cpSync(source, path.join(assets, asset), { recursive: true });
}
