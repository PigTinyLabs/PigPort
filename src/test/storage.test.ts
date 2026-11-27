import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GOOGLE_PLAY_AVD, ManagedAndroid, MANAGED_AVD } from '../main/runtime/managedAndroid';
import { moveGameStorage } from '../main/runtime/storage';

async function fixture(t: TestContext) {
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'pigport-storage-'));
  t.after(() => fs.rm(work, { recursive: true, force: true }));
  const source = path.join(work, 'PlayBridge');
  const parent = path.join(work, 'External drive');
  const destination = path.join(await fs.realpath(work), 'External drive', 'PigPort Data');
  await fs.mkdir(path.join(source, 'ios', 'Containers'), { recursive: true });
  await fs.mkdir(parent);
  await fs.writeFile(path.join(source, 'ios', 'Containers', 'saved'), 'game data');
  await fs.writeFile(path.join(source, 'settings.json'), 'settings');
  return { source, parent, destination };
}

test('activates the copied game storage before removing the original and leaves settings in place', async (t) => {
  const { source, parent, destination } = await fixture(t);
  const result = await moveGameStorage(source, parent, async () => {}, async (active) => {
    assert.equal(active, destination);
    assert.equal(await fs.readFile(path.join(active, 'ios', 'Containers', 'saved'), 'utf8'), 'game data');
    assert.equal(await fs.readFile(path.join(source, 'ios', 'Containers', 'saved'), 'utf8'), 'game data');
  }, () => {});
  assert.deepEqual(result, { path: destination, remaining: [] });
  await assert.rejects(fs.stat(path.join(source, 'ios')), { code: 'ENOENT' });
  assert.equal(await fs.readFile(path.join(source, 'settings.json'), 'utf8'), 'settings');
});

test('preserves the original game data when the storage preference cannot be saved', async (t) => {
  const { source, parent, destination } = await fixture(t);
  await assert.rejects(moveGameStorage(source, parent, async () => {}, async () => {
    throw new Error('Preference write failed');
  }, () => {}), /Preference write failed/);
  assert.equal(await fs.readFile(path.join(source, 'ios', 'Containers', 'saved'), 'utf8'), 'game data');
  await assert.rejects(fs.stat(destination), { code: 'ENOENT' });
  assert.deepEqual(await fs.readdir(parent), []);
});

test('rewrites copied Android device paths for its final location', {
  skip: process.platform !== 'darwin' && process.platform !== 'win32',
}, async (t) => {
  const { source, parent, destination } = await fixture(t);
  const relative = path.join('runtime', 'android');
  const sdkPath = new ManagedAndroid(path.join(source, relative));
  for (const profile of [MANAGED_AVD, GOOGLE_PLAY_AVD]) {
    const avdDir = path.join(sdkPath.avdHome, profile + '.avd');
    await fs.mkdir(avdDir, { recursive: true });
    await fs.writeFile(path.join(avdDir, 'config.ini'), 'image.sysdir.1=/old/image/\nhw.keyboard=yes\n');
    await fs.writeFile(path.join(sdkPath.avdHome, profile + '.ini'), 'path=/old/avd\ntarget=android-35\n');
  }
  await moveGameStorage(source, parent,
    (staged, active) => new ManagedAndroid(path.join(staged, relative)).relocateAvd(new ManagedAndroid(path.join(active, relative))),
    async () => {}, () => {});
  const active = new ManagedAndroid(path.join(destination, relative));
  for (const [profile, tag] of [[MANAGED_AVD, active.abi === 'arm64-v8a' ? 'default' : 'google_apis'], [GOOGLE_PLAY_AVD, 'google_apis_playstore']]) {
    const avdDir = path.join(active.avdHome, profile + '.avd');
    assert.equal(await fs.readFile(path.join(active.avdHome, profile + '.ini'), 'utf8'), `path=${avdDir}\ntarget=android-35\n`);
    const config = await fs.readFile(path.join(avdDir, 'config.ini'), 'utf8');
    const image = path.join(active.sdk, 'system-images', 'android-35', tag, active.abi);
    assert.equal(config, `image.sysdir.1=${image}${path.sep}\nhw.keyboard=yes\n`);
  }
});
