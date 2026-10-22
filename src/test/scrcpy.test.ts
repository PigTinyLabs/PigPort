import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeKeycode, encodeTouch, StreamMeta, StreamPacket, VideoStreamParser } from '../main/android/scrcpy';
import { parseDevices, parsePackages } from '../main/android/adb';

test('touch message matches the scrcpy 32-byte layout', () => {
  const b = encodeTouch(0, 5, 100, 200, 1080, 2400);
  assert.equal(b.length, 32);
  assert.equal(b[0], 2);
  assert.equal(b[1], 0);
  assert.equal(b.readBigInt64BE(2), 5n);
  assert.equal(b.readInt32BE(10), 100);
  assert.equal(b.readInt32BE(14), 200);
  assert.equal(b.readUInt16BE(18), 1080);
  assert.equal(b.readUInt16BE(20), 2400);
  assert.equal(b.readUInt16BE(22), 0xffff);
  assert.equal(encodeTouch(1, 5, 0, 0, 1, 1).readUInt16BE(22), 0, 'no pressure on release');
});

test('keycode message is 14 bytes', () => {
  const b = encodeKeycode(1, 4);
  assert.deepEqual([...b], [0, 1, 0, 0, 0, 4, 0, 0, 0, 0, 0, 0, 0, 0]);
});

function header(ptsFlags: bigint, size: number): Buffer {
  const h = Buffer.alloc(12);
  h.writeBigUInt64BE(ptsFlags, 0);
  h.writeUInt32BE(size, 8);
  return h;
}

test('video parser handles meta, session and media packets split across chunks', () => {
  const name = Buffer.alloc(64);
  name.write('Pixel 9');
  const session = Buffer.alloc(12);
  session[0] = 0x80;
  session.writeUInt32BE(1080, 4);
  session.writeUInt32BE(2400, 8);
  const config = Buffer.from([0, 0, 0, 1, 0x67, 0x64, 0x00, 0x28]);
  const frame = Buffer.from([0, 0, 0, 1, 0x65, 1, 2, 3]);
  const stream = Buffer.concat([
    Buffer.from([0]), name, Buffer.from('h264', 'latin1'), session,
    header(1n << 62n, config.length), config,
    header((1n << 61n) | 16_666n, frame.length), frame,
  ]);

  const metas: StreamMeta[] = [];
  const packets: StreamPacket[] = [];
  const p = new VideoStreamParser((m) => metas.push(m), (pk) => packets.push(pk));
  for (let i = 0; i < stream.length; i += 7) p.push(stream.subarray(i, i + 7));

  assert.deepEqual(metas, [{ deviceName: 'Pixel 9', codec: 'h264', width: 1080, height: 2400 }]);
  assert.equal(packets.length, 2);
  assert.deepEqual(packets[0], { config: true, key: false, pts: 0, data: new Uint8Array(config) });
  assert.deepEqual(packets[1], { config: false, key: true, pts: 16_666, data: new Uint8Array(frame) });
});

test('adb output parsing', () => {
  const devices = parseDevices('List of devices attached\nemulator-5554  device product:sdk model:sdk_gphone64_arm64 transport_id:1\n127.0.0.1:5555 unauthorized transport_id:2\n\n');
  assert.deepEqual(devices, [
    { serial: 'emulator-5554', state: 'device', model: 'sdk gphone64 arm64' },
    { serial: '127.0.0.1:5555', state: 'unauthorized', model: undefined },
  ]);
  assert.deepEqual(parsePackages('package:com.b.game\r\npackage:com.a.game\n'), [{ id: 'com.a.game' }, { id: 'com.b.game' }]);
});
