import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Adb } from '../main/android/adb';
import { assertAbi, waitForAndroid, launchComponent, TextTail } from '../main/android/health';
import { emulatorArguments } from '../main/runtime/android';

test('connected Android is not considered ready until its package manager is available', async () => {
  const adb = new Adb('unused');
  adb.shell = async (_serial, args) => args[0] === 'getprop' ? '1' : '';
  await assert.rejects(waitForAndroid(adb, 'device', 0), /package manager/);
  adb.shell = async (_serial, args) => args[0] === 'getprop' ? '1' : 'package:/system/framework/framework-res.apk';
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
test('diagnostic collection takes a finite snapshot without clearing logs or starting a logger', async () => {
  const adb = new Adb('unused'); const calls: string[][] = [];
  adb.shell = async () => 'sample';
  adb.run = async (args) => { calls.push(args); return 'crash sample'; };
  assert.match(await adb.diagnostics('device', 'io.demo.game'), /crash sample/);
  assert.ok(calls[0].includes('-d')); assert.ok(calls[0].includes('-t')); assert.ok(!calls[0].includes('-c'));
});
