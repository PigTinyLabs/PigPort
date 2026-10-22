import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { androidMetadata } from '../main/packages/manifest';
import { Store } from '../main/store';
import { Adb } from '../main/android/adb';
import { ensureAndroid } from '../main/runtime/android';

// Minimal compiled Android XML with both raw and typed-string attributes.
function manifest(utf8: boolean): Buffer {
  const values = ['manifest', 'package', 'io.example.demo', 'versionName', '1.2.3'];
  const encoded = values.map((s) => utf8 ? Buffer.concat([Buffer.from([s.length, Buffer.byteLength(s)]), Buffer.from(s), Buffer.alloc(1)])
    : Buffer.concat([Buffer.from([s.length, 0]), Buffer.from(s, 'utf16le'), Buffer.alloc(2)]));
  const pool = Buffer.alloc(28 + values.length * 4 + encoded.reduce((n, b) => n + b.length, 0));
  pool.writeUInt16LE(1); pool.writeUInt16LE(28, 2); pool.writeUInt32LE(pool.length, 4);
  pool.writeUInt32LE(values.length, 8); pool.writeUInt32LE(utf8 ? 0x100 : 0, 16); pool.writeUInt32LE(48, 20);
  let off = 0;
  encoded.forEach((b, i) => { pool.writeUInt32LE(off, 28 + i * 4); b.copy(pool, 48 + off); off += b.length; });
  const tag = Buffer.alloc(76);
  tag.writeUInt16LE(0x102); tag.writeUInt16LE(16, 2); tag.writeUInt32LE(76, 4);
  tag.writeUInt32LE(0xffffffff, 16); tag.writeUInt32LE(0, 20);
  tag.writeUInt16LE(20, 24); tag.writeUInt16LE(20, 26); tag.writeUInt16LE(2, 28);
  tag.writeUInt32LE(0xffffffff, 36); tag.writeUInt32LE(1, 40); tag.writeUInt32LE(2, 44);
  tag.writeUInt32LE(0xffffffff, 56); tag.writeUInt32LE(3, 60); tag.writeUInt32LE(0xffffffff, 64);
  tag[71] = 3; tag.writeUInt32LE(4, 72);
  const head = Buffer.alloc(8); head.writeUInt16LE(3); head.writeUInt16LE(8, 2); head.writeUInt32LE(8 + pool.length + tag.length, 4);
  return Buffer.concat([head, pool, tag]);
}

test('APK package identity is read from UTF-8 and UTF-16 compiled manifests', () => {
  for (const utf8 of [true, false]) assert.deepEqual(androidMetadata(manifest(utf8)), { bundleId: 'io.example.demo', version: '1.2.3' });
});
test('malformed manifest chunks fail before installation', () => {
  const data = manifest(true); data.writeUInt32LE(0xffffffff, 12);
  assert.throws(() => androidMetadata(data), /Malformed/);
});
test('saved library survives restart and interrupted installs can be retried', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'playbridge-library-'));
  try {
    const store = new Store(dir);
    await store.saveLibrary([{ file: '/games/demo.apk', name: 'Demo', kind: 'apk', size: 123, architectures: [], note: '', status: 'installing' }]);
    const restored = await new Store(dir).library();
    assert.equal(restored[0].file, '/games/demo.apk');
    assert.equal(restored[0].status, 'error');
    assert.match(restored[0].error!, /interrupted/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('installation does not silently switch away from a disconnected selected device', async () => {
  const adb = new Adb('unused');
  adb.devices = async () => [{ serial: 'other-phone', state: 'device' }];
  await assert.rejects(ensureAndroid(adb, 'my-phone'), /disconnected/);
});
test('multiple Android devices require explicit selection', async () => {
  const adb = new Adb('unused');
  adb.devices = async () => [{ serial: 'phone', state: 'device' }, { serial: 'emulator-5554', state: 'device' }];
  await assert.rejects(ensureAndroid(adb), /Choose/);
  assert.equal(await ensureAndroid(adb, 'emulator-5554'), 'emulator-5554');
});
test('an unauthorized phone reports the authorization prompt', async () => {
  const adb = new Adb('unused'); adb.devices = async () => [{ serial: 'phone', state: 'unauthorized' }];
  await assert.rejects(ensureAndroid(adb), /Allow USB debugging/);
});
test('failed Android activity launch is not reported as success', async () => {
  const adb = new Adb('unused'); adb.shell = async () => 'No activities found to run, monkey aborted.';
  await assert.rejects(adb.launch('phone', 'io.demo.game'), /could not launch/);
  adb.shell = async () => 'Events injected: 1';
  await adb.launch('phone', 'io.demo.game');
});
