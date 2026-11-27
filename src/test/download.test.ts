import { test } from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { mkdtemp, readFile, access, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { downloadVerified } from '../main/runtime/download';
import { GOOGLE_PLAY_AVD, ManagedAndroid, MANAGED_AVD } from '../main/runtime/managedAndroid';

// Fake only the transport, retaining the real streaming/file/hash implementation.
test('runtime download publishes only complete, checksum-verified files', async (t) => {
  const bytes = Buffer.from('official runtime fixture');
  t.mock.method(https, 'get', (...args: unknown[]) => {
    const callback = args[args.length - 1] as (res: unknown) => void;
    const res = Object.assign(Readable.from([bytes.subarray(0, 6), bytes.subarray(6)]), { statusCode: 200, headers: {} });
    queueMicrotask(() => callback(res));
    return Object.assign(new EventEmitter(), { setTimeout() { return this; } });
  });
  const dir = await mkdtemp(path.join(os.tmpdir(), 'playbridge-download-'));
  try {
    const target = path.join(dir, 'runtime.zip');
    const sum = createHash('sha256').update(bytes).digest('hex');
    await downloadVerified('https://dl.google.com/android/repository/fixture.zip', target, bytes.length, 'sha256', sum, () => undefined);
    assert.deepEqual(await readFile(target), bytes);
    const bad = path.join(dir, 'bad.zip');
    await assert.rejects(downloadVerified('https://dl.google.com/android/repository/fixture.zip', bad, bytes.length, 'sha256', '0'.repeat(64), () => undefined), /mismatch/);
    await assert.rejects(access(bad)); await assert.rejects(access(bad + '.download'));
    await assert.rejects(downloadVerified('https://dl.google.com/android/repository/fixture.zip', bad, 2, 'sha256', sum, () => undefined), /exceeds/);
    await assert.rejects(access(bad)); await assert.rejects(access(bad + '.download'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('Android setup cannot start without reviewing and accepting a current license plan', async () => {
  const runtime = new ManagedAndroid('/unused-runtime-directory');
  await assert.rejects(runtime.install('invented-token', false), /Review and accept/);
  await assert.rejects(runtime.install('invented-token', true), /Review and accept/);
});

test('adding Google Play reuses SDK tools and preserves the original Android profile', { skip: process.platform !== 'darwin' }, async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'pigport-google-play-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  t.mock.method(fs, 'statfs', async () => ({ bavail: 10 * 1024 ** 2, bsize: 4096 }));
  const runtime = new ManagedAndroid(path.join(dir, 'runtime'));
  const oldTag = runtime.abi === 'arm64-v8a' ? 'default' : 'google_apis';
  const oldAvd = path.join(runtime.avdHome, MANAGED_AVD + '.avd');
  for (const [file, content] of [
    [runtime.adbPath, 'existing adb'],
    [path.join(runtime.sdk, 'emulator', 'emulator'), 'existing emulator'],
    [path.join(runtime.sdk, 'system-images', 'android-35', oldTag, runtime.abi, 'system.img'), 'original system'],
    [path.join(runtime.avdHome, MANAGED_AVD + '.ini'), 'original pointer'],
    [path.join(oldAvd, 'config.ini'), 'original configuration'],
    [path.join(oldAvd, 'userdata-qemu.img'), 'game data'],
    [path.join(runtime.root, 'installed.json'), JSON.stringify({ imageId: `system-images;android-35;${oldTag};${runtime.abi}` })],
  ]) {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
  }
  const source = path.join(dir, runtime.abi);
  await mkdir(source);
  await writeFile(path.join(source, 'system.img'), 'google system');
  const archive = path.join(dir, 'fixture.zip');
  execFileSync('/usr/bin/ditto', ['-c', '-k', '--keepParent', source, archive]);
  const bytes = await readFile(archive);
  const checksum = createHash('sha256').update(bytes).digest('hex');
  const id = `system-images;android-35;google_apis_playstore;${runtime.abi}`;
  const xml = `<repository><license id="test-license">Fixture terms</license>
    <remotePackage path="${id}"><uses-license ref="test-license"/><archives><archive><complete>
    <size>${bytes.length}</size><checksum type="sha256">${checksum}</checksum><url>fixture.zip</url>
    </complete></archive></archives></remotePackage></repository>`;
  t.mock.method(https, 'get', (url: URL, _opts: unknown, callback: (response: unknown) => void) => {
    assert.ok(url.pathname.includes('/sys-img/google_apis_playstore/'));
    const data = url.pathname.endsWith('.xml') ? Buffer.from(xml) : bytes;
    queueMicrotask(() => callback(Object.assign(Readable.from([data]), { statusCode: 200, headers: {} })));
    return Object.assign(new EventEmitter(), { setTimeout() { return this; } });
  });

  const plan = await runtime.prepare(GOOGLE_PLAY_AVD);
  assert.deepEqual(plan.packages, [id]);
  await runtime.install(plan.token, true);
  assert.deepEqual(await runtime.readyAvds(), [MANAGED_AVD, GOOGLE_PLAY_AVD]);
  assert.equal(await readFile(path.join(oldAvd, 'userdata-qemu.img'), 'utf8'), 'game data');
  assert.equal(await readFile(path.join(oldAvd, 'config.ini'), 'utf8'), 'original configuration');
  assert.equal(await readFile(runtime.adbPath, 'utf8'), 'existing adb');
  assert.match(await readFile(path.join(runtime.avdHome, GOOGLE_PLAY_AVD + '.avd', 'config.ini'), 'utf8'), /^PlayStore\.enabled=true$/m);
});
