import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { inspectPackage } from '../main/packages/packages';
import { plistMetadata } from '../main/packages/plist';

// Independent ZIP fixture writer; packages never need extracting to disk.
function zip(entries: [string, Buffer][]): Buffer {
  const local: Buffer[] = [], central: Buffer[] = [];
  let offset = 0;
  for (const [filename, data] of entries) {
    const name = Buffer.from(filename), packed = deflateRawSync(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(8, 8);
    header.writeUInt32LE(packed.length, 18); header.writeUInt32LE(data.length, 22); header.writeUInt16LE(name.length, 26);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50); record.writeUInt16LE(8, 10);
    record.writeUInt32LE(packed.length, 20); record.writeUInt32LE(data.length, 24); record.writeUInt16LE(name.length, 28); record.writeUInt32LE(offset, 42);
    local.push(header, name, packed); central.push(record, name);
    offset += header.length + name.length + packed.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
const xml = Buffer.from('<plist><dict><key>CFBundleIdentifier</key><string>io.example.game</string><key>CFBundleDisplayName</key><string>Fire &amp; Ice</string><key>MinimumOSVersion</key><string>15.0</string></dict></plist>');
const binary = Buffer.from('YnBsaXN0MDDUAQIDBAUGBwhfEBNDRkJ1bmRsZURpc3BsYXlOYW1lXxASQ0ZCdW5kbGVJZGVudGlmaWVyXxAaQ0ZCdW5kbGVTaG9ydFZlcnNpb25TdHJpbmdfEBBNaW5pbXVtT1NWZXJzaW9uaABUAHIA8gAgAGMAaAGhAGlfEA9pby5leGFtcGxlLmRlbW9TMS4yVDE1LjAIESc8WWx9j5MAAAAAAAABAQAAAAAAAAAJAAAAAAAAAAAAAAAAAAAAmA==', 'base64');

test('reads binary Apple plist with Vietnamese UTF-16 strings', () => {
  const p = plistMetadata(binary);
  assert.equal(p.CFBundleDisplayName, 'Trò chơi');
  assert.equal(p.CFBundleIdentifier, 'io.example.demo');
  assert.equal(p.CFBundleShortVersionString, '1.2');
});

test('inspects IPA/APK and rejects malformed or ambiguous archives', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'playbridge-test-'));
  try {
    const ipa = path.join(dir, 'game.ipa'), apk = path.join(dir, 'game.apk');
    await writeFile(ipa, zip([['Payload/Game.app/Info.plist', xml]]));
    const info = await inspectPackage(ipa);
    assert.equal(info.kind, 'ipa'); assert.equal(info.bundleId, 'io.example.game');
    assert.equal(info.name, 'Fire & Ice'); assert.equal(info.minimumOS, '15.0');
    await writeFile(ipa, zip([['Payload/Game.app/Info.plist', binary]]));
    assert.equal((await inspectPackage(ipa)).name, 'Trò chơi');
    await writeFile(apk, zip([['AndroidManifest.xml', Buffer.from('<manifest/>')], ['lib/arm64-v8a/libgame.so', Buffer.alloc(0)]]));
    assert.deepEqual((await inspectPackage(apk)).architectures, ['arm64-v8a']);
    await writeFile(ipa, zip([['Info.plist', xml]]));
    await assert.rejects(inspectPackage(ipa), /Payload/);
    await writeFile(ipa, zip([['Payload/A.app/Info.plist', xml], ['Payload/B.app/Info.plist', xml]]));
    await assert.rejects(inspectPackage(ipa), /exactly one/);
    await writeFile(apk, zip([['classes.dex', Buffer.alloc(0)]]));
    await assert.rejects(inspectPackage(apk), /AndroidManifest/);
    await writeFile(ipa, Buffer.from('not a zip'));
    await assert.rejects(inspectPackage(ipa), /valid ZIP/);
    await writeFile(ipa, zip([['Payload/Game.app/Info.plist', Buffer.alloc(9 * 1024 * 1024)]]));
    await assert.rejects(inspectPackage(ipa), /exceeds/);
    await writeFile(ipa, zip([['Payload/Game.app/Info.plist', xml], ['Payload/Game.app/Info.plist', xml]]));
    await assert.rejects(inspectPackage(ipa), /Duplicate/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('rejects broken binary plist object tables', () => {
  assert.throws(() => plistMetadata(Buffer.from('bplist00')), /Truncated/);
  const corrupt = Buffer.from(binary); corrupt.fill(255, corrupt.length - 8);
  assert.throws(() => plistMetadata(corrupt), /too large|offset/);
});
