// Downloads the scrcpy server jar that runs on the Android device.
// The client protocol in src/main/android/scrcpy.ts targets this version;
// the server refuses to start if the version argument does not match.
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const VERSION = process.argv[2] ?? '5.0.1';
const url = `https://github.com/Genymobile/scrcpy/releases/download/v${VERSION}/scrcpy-server-v${VERSION}`;
const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'resources');

const res = await fetch(url);
if (!res.ok) {
  console.error(`Download failed: ${res.status} ${res.statusText} (${url})`);
  process.exit(1);
}
const jar = Buffer.from(await res.arrayBuffer());
if (jar.subarray(0, 2).toString('latin1') !== 'PK') {
  console.error('Downloaded file is not a jar');
  process.exit(1);
}
mkdirSync(dir, { recursive: true });
writeFileSync(path.join(dir, 'scrcpy-server'), jar);
writeFileSync(path.join(dir, 'scrcpy-server.version'), VERSION + '\n');
console.log(`scrcpy-server ${VERSION} saved to resources/ (${jar.length} bytes)`);
