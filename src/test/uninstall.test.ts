import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { NativeIpaRuntime } from '../main/runtime/ipa';

const exists = (p: string) => stat(p).then(() => true, () => false);

test('IPA uninstall keeps or deletes game data and refuses while the game runs', { skip: process.platform !== 'darwin' }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'playbridge-uninstall-'));
  const id = 'io.playbridge.uninstall-test';
  const run = path.join(await realpath(execFileSync('/usr/bin/getconf', ['DARWIN_USER_CACHE_DIR'], { encoding: 'utf8' }).trim()), 'io.playbridge.ios');
  const clone = path.join(run, 'Applications', id + '.app'), home = path.join(run, 'Homes', id);
  const installed = path.join(root, 'Applications', id + '.app'), data = path.join(root, 'Containers', id);
  const setUp = async () => {
    for (const dir of [installed, clone, path.join(data, 'Documents'), path.dirname(home)]) await mkdir(dir, { recursive: true });
    await writeFile(path.join(data, 'Documents', 'save.dat'), 'progress');
    await writeFile(clone + '.stamp', 'stamp');
    await rm(home, { force: true }); await symlink(data, home);
  };
  const runtime = new NativeIpaRuntime(root);
  try {
    await setUp();
    assert.ok(await runtime.dataSize(id) > 0);
    // A process running from the launch copy blocks uninstalling.
    const game = spawn('/bin/sleep', ['30'], { argv0: path.join(clone, 'game') });
    await new Promise((r) => setTimeout(r, 200));
    try { await assert.rejects(runtime.uninstall(id, false), /Quit the game/); } finally { game.kill(); }
    await new Promise((r) => game.once('exit', r));

    await runtime.uninstall(id, false);
    for (const gone of [installed, clone, clone + '.stamp', home]) assert.equal(await exists(gone), false, gone);
    assert.equal(await exists(path.join(data, 'Documents', 'save.dat')), true);

    await setUp();
    await runtime.uninstall(id, true);
    assert.equal(await exists(data), false);
  } finally {
    for (const p of [root, clone, clone + '.stamp', home]) await rm(p, { recursive: true, force: true });
  }
});
