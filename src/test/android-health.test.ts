import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Adb } from '../main/android/adb';
import { assertAbi, waitForAndroid, launchComponent, TextTail } from '../main/android/health';
import { directDisplayProfile, emulatorArguments } from '../main/runtime/android';
import { prepareQuickBoot } from '../main/runtime/quickBoot';

test('connected Android is not considered ready until its package manager is available', async () => {
  const adb = new Adb('unused');
  adb.shell = async () => '1\nError: package manager is unavailable';
  await assert.rejects(waitForAndroid(adb, 'device', 0), /package manager/);
  adb.shell = async () => '0\npackage:/system/framework/framework-res.apk';
  await assert.rejects(waitForAndroid(adb, 'device', 0), /package manager/);
  adb.shell = async () => '1\npackage:/system/framework/framework-res.apk';
  await waitForAndroid(adb, 'device', 0);
});
test('arm64 XAPK is rejected on x86 Android and accepted on matching ARM Android', async () => {
  const adb = new Adb('unused'); adb.shell = async () => 'x86_64,x86';
  await assert.rejects(assertAbi(adb, 'device', ['arm64_v8a']), /does not match/);
  adb.shell = async () => 'arm64-v8a,armeabi-v7a';
  await assertAbi(adb, 'device', ['arm64_v8a']);
});
test('an accepted activity launch followed by immediate process exit is reported', async () => {
  const adb = new Adb('unused');
  adb.shell = async (_serial, args) => args[0] === 'cmd' ? 'io.demo.game/.MainActivity' : args[0] === 'am' ? 'Status: ok' : '';
  await assert.rejects(adb.launch('device', 'io.demo.game', 0), /exited during startup/);
});
test('resolver must return the requested package, not another application', () => {
  assert.throws(() => launchComponent('other.app/.Main', 'io.demo.game'), /launcher activity/);
  assert.equal(launchComponent('priority=0\nio.demo.game/.Main', 'io.demo.game'), 'io.demo.game/.Main');
});
test('emulator output tail stays bounded during noisy failures', () => {
  const tail = new TextTail(16);
  for (let i = 0; i < 100; i++) tail.append('12345678');
  tail.append('END'); assert.equal(Buffer.byteLength(tail.text()), 16); assert.ok(tail.text().endsWith('END'));
});
test('managed tablet boots without snapshots; software mode does not wipe game data', () => {
  const args = emulatorArguments('PigPort', true, 'software');
  assert.ok(args.includes('-no-snapshot')); assert.ok(args.includes('swiftshader')); assert.ok(args.includes('1280x800'));
  assert.ok(!args.includes('-wipe-data')); assert.deepEqual(emulatorArguments('External', false, 'auto'), ['-avd', 'External', '-no-boot-anim']);
});
test('direct playback starts a visible emulator with hardware graphics or the selected software renderer', () => {
  const direct = emulatorArguments('PigPort', true, 'auto', true);
  assert.ok(!direct.includes('-no-window'));
  assert.ok(!direct.includes('-wipe-data'));
  assert.equal(direct[direct.indexOf('-gpu') + 1], 'host');
  const fallback = emulatorArguments('PigPort', true, 'software', true);
  assert.ok(!fallback.includes('-no-window'));
  assert.equal(fallback[fallback.indexOf('-gpu') + 1], 'swiftshader');
});
test('automatic direct playback uses lower resolution on M1 and avoids oversizing an 8 GiB Mac VM', () => {
  const gib = 1024 ** 3;
  assert.deepEqual(directDisplayProfile('auto', true, 8 * gib, 'Apple M1'), { size: '800x500', limitedMemory: true });
  assert.deepEqual(directDisplayProfile(undefined, true, 16 * gib, 'Apple M1'), { size: '800x500', limitedMemory: false });
  assert.deepEqual(directDisplayProfile('auto', true, 48 * gib, 'Apple M4 Pro'), { size: '960x600', limitedMemory: false });
  assert.deepEqual(directDisplayProfile('auto', false, 8 * gib, ''), { size: '1280x800', limitedMemory: false });
  assert.equal(directDisplayProfile('1280x800', true, 8 * gib, 'Apple M1').size, '1280x800');
  const args = emulatorArguments('PigPort', true, 'auto', true, { size: '800x500', limitedMemory: true, angle: true });
  for (const [flag, value] of [['-skin', '800x500'], ['-lcd-scaling-factor', '0.625'], ['-memory', '2560'], ['-cores', '3'], ['-feature', 'GuestAngle']]) {
    assert.equal(args[args.indexOf(flag) + 1], value);
  }
});
test('Quick Boot accepts a fresh snapshot from the same profile and rejects one from before a cold or headless run', async (t) => {
  t.mock.method(fs, 'statfs', async () => ({ bsize: 4096, bavail: 2_000_000 }));
  const avd = await fs.mkdtemp(path.join(os.tmpdir(), 'pigport-quick-boot-'));
  try {
    const profile = 'opengl:800x500:true';
    assert.equal(await prepareQuickBoot(avd, profile), 'cold');
    const snapshot = path.join(avd, 'snapshots', 'default_boot');
    await fs.mkdir(snapshot, { recursive: true });
    const marker = path.join(avd, 'pigport-quick-boot.json');
    const beforeSave = new Date(Date.now() - 5000);
    await fs.utimes(marker, beforeSave, beforeSave);
    await fs.writeFile(path.join(snapshot, 'snapshot.pb'), 'metadata');
    assert.equal(await prepareQuickBoot(avd, profile), 'cold');
    await fs.utimes(marker, beforeSave, beforeSave);
    await fs.writeFile(path.join(snapshot, 'ram.bin'), 'ram');
    assert.equal(await prepareQuickBoot(avd, profile), 'restore');
    assert.equal(await prepareQuickBoot(avd, profile), 'cold');
    await fs.utimes(marker, beforeSave, beforeSave);
    assert.equal(await prepareQuickBoot(avd, undefined), 'off');
    assert.equal(await prepareQuickBoot(avd, profile), 'cold');
    assert.ok(emulatorArguments('PigPort', true, 'opengl', true, { quickBoot: 'cold' }).includes('-no-snapshot-load'));
    assert.ok(emulatorArguments('PigPort', true, 'opengl', true, { quickBoot: 'restore' }).every((arg) => !arg.startsWith('-no-snapshot')));
  } finally { await fs.rm(avd, { force: true, recursive: true }); }
});
test('diagnostic collection takes a finite snapshot without clearing logs or starting a logger', async () => {
  const adb = new Adb('unused'); const calls: string[][] = [];
  adb.shell = async () => 'sample';
  adb.run = async (args) => { calls.push(args); return 'crash sample'; };
  assert.match(await adb.diagnostics('device', 'io.demo.game'), /crash sample/);
  assert.ok(calls[0].includes('-d')); assert.ok(calls[0].includes('-t')); assert.ok(!calls[0].includes('-c'));
});
