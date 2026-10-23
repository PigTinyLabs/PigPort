import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AirPlayReceiver, parseClient } from '../main/airplay';

test('the mirroring iPhone is read from the UxPlay log', () => {
  assert.equal(parseClient("connection request from Tiny's iPhone (iPhone16,2) with deviceID = AA:BB:CC:DD:EE:FF\n"), "Tiny's iPhone (iPhone16,2)");
  assert.equal(parseClient('UxPlay 1.74: An Open-Source AirPlay mirroring and audio-streaming server.'), undefined);
});

test('receiver status reports the platform path', async () => {
  const receiver = new AirPlayReceiver('/nonexistent/airplay', '/tmp');
  const status = await receiver.status();
  if (process.platform === 'darwin') {
    assert.equal(status.platform, 'mac');
    assert.ok(status.name.length > 0);
  } else if (process.platform === 'win32') {
    assert.equal(status.platform, 'windows');
    assert.equal(status.available, false);
    await assert.rejects(receiver.start(), /not included/);
  }
  assert.match(receiver.name, /^PigPort /);
});
