import { test } from 'node:test';
import assert from 'node:assert/strict';
import { convertMachHeader } from '../main/runtime/macho';
import { validateIpaEntries } from '../main/runtime/ipa';
import { latestPackage, repositoryPackages } from '../main/runtime/repository';
import { officialUrl } from '../main/runtime/download';
import type { ArchiveEntry } from '../main/packages/archive';

function binary(encrypted = false, legacy = false): Buffer {
  const b = Buffer.alloc(1024);
  b.writeUInt32LE(0xfeedfacf); b.writeUInt32LE(0x100000c, 4); b.writeUInt32LE(2, 12);
  b.writeUInt32LE(3, 16); b.writeUInt32LE(152 + (legacy ? 16 : 24) + 24, 20);
  b.writeUInt32LE(0x19, 32); b.writeUInt32LE(152, 36); b.write('__TEXT', 40);
  b.writeBigUInt64LE(1024n, 80); b.writeUInt32LE(1, 96);
  b.writeUInt32LE(512, 152);
  const p = 184;
  b.writeUInt32LE(legacy ? 0x25 : 0x32, p); b.writeUInt32LE(legacy ? 16 : 24, p + 4);
  if (legacy) { b.writeUInt32LE(0xc0000, p + 8); b.writeUInt32LE(0xc0000, p + 12); }
  else { b.writeUInt32LE(2, p + 8); b.writeUInt32LE(0xf0000, p + 12); b.writeUInt32LE(0xf0000, p + 16); }
  const enc = p + (legacy ? 16 : 24); b.writeUInt32LE(0x2c, enc); b.writeUInt32LE(24, enc + 4); b.writeUInt32LE(encrypted ? 1 : 0, enc + 16);
  b.fill(0x7a, 512); return b;
}
test('iOS ARM64 conversion preserves code while changing the platform to Catalyst', () => {
  const original = binary(), patched = convertMachHeader(original, original.length);
  assert.equal(patched.readUInt32LE(192), 6);
  assert.deepEqual(patched.subarray(512), original.subarray(512));
  assert.equal(original.readUInt32LE(192), 2);
});
test('legacy iOS load command converts without moving executable sections', () => {
  const original = binary(false, true), patched = convertMachHeader(original, original.length);
  assert.equal(patched.readUInt32LE(184), 0x32); assert.equal(patched.readUInt32LE(192), 6);
  assert.equal(patched.readUInt32LE(20), original.readUInt32LE(20) + 8);
  assert.deepEqual(patched.subarray(512), original.subarray(512));
});
test('encrypted and non-iOS binaries are rejected without decryption', () => {
  assert.throws(() => convertMachHeader(binary(true), 1024), /encrypted/);
  const desktop = binary(); desktop.writeUInt32LE(1, 192);
  assert.throws(() => convertMachHeader(desktop, 1024), /Unsupported/);
});
test('IPA extraction rejects traversal, symlinks and filesystem name collisions', () => {
  const entry: ArchiveEntry = { offset: 0, compressed: 1, size: 1, method: 0, flags: 0, mode: 0o100644 };
  for (const name of ['../outside', '/outside', 'Payload/../../outside', 'Payload\\evil', 'C:evil']) {
    assert.throws(() => validateIpaEntries(new Map([[name, entry]])), /Unsafe/);
  }
  assert.throws(() => validateIpaEntries(new Map([['Payload/link', { ...entry, mode: 0o120777 }]])), /symbolic/);
  assert.throws(() => validateIpaEntries(new Map([['Payload/A', entry], ['Payload/a', entry]])), /conflicting/);
});
function repository(): string {
  return `<sdk-repository><license id="terms">Vendor terms &amp; conditions</license>
  ${['darwin_aarch64', 'darwin_x64', 'windows_x64'].map((target) => `<remotePackage path="emulator"><revision><major>36</major><minor>2</minor><micro>1</micro></revision><uses-license ref="terms"/><channelRef ref="channel-0"/><archives><archive><host-os>${target.startsWith('darwin') ? 'macosx' : 'windows'}</host-os><complete><size>12345</size><checksum type="sha1">${'a'.repeat(40)}</checksum><url>emulator-${target}.zip</url></complete></archive></archives></remotePackage>`).join('')}
  </sdk-repository>`;
}
test('Android package selection respects host architecture and preserves license text', () => {
  const mac = latestPackage(repositoryPackages(repository(), 'https://dl.google.com/android/repository/', 'macosx', 'arm64'), 'emulator');
  assert.match(mac.url, /darwin_aarch64/); assert.equal(mac.licenseText, 'Vendor terms & conditions');
  const windows = latestPackage(repositoryPackages(repository(), 'https://dl.google.com/android/repository/', 'windows', 'x64'), 'emulator');
  assert.match(windows.url, /windows_x64/);
});
test('runtime metadata cannot redirect downloads to untrusted sources', () => {
  assert.throws(() => officialUrl('https://evil.test/sdk.zip'), /official/);
  assert.throws(() => officialUrl('http://dl.google.com/sdk.zip'), /official/);
  assert.throws(() => repositoryPackages(repository().replace('emulator-darwin_aarch64.zip', 'https://evil.test/darwin_aarch64.zip'), 'https://dl.google.com/android/repository/', 'macosx', 'arm64'), /official/);
});
