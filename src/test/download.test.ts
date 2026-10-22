import { test } from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, access, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { downloadVerified } from '../main/runtime/download';
import { ManagedAndroid } from '../main/runtime/managedAndroid';

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
