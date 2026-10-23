import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Adb, parseMdnsServices, parseWlanAddress } from '../main/android/adb';

test('mDNS services list pairing and connect addresses of Wi-Fi phones', () => {
  const out = [
    'List of discovered mdns services',
    'adb-R58M12345-AbCdEf\t_adb-tls-pairing._tcp\t192.168.1.23:41235',
    'adb-R58M12345-AbCdEf\t_adb-tls-connect._tcp.\t192.168.1.23:37123',
    'emulator-legacy\t_adb._tcp\t192.168.1.40:5555',
    '',
  ].join('\n');
  assert.deepEqual(parseMdnsServices(out), [
    { name: 'adb-R58M12345-AbCdEf', kind: 'pairing', address: '192.168.1.23:41235' },
    { name: 'adb-R58M12345-AbCdEf', kind: 'connect', address: '192.168.1.23:37123' },
    { name: 'emulator-legacy', kind: 'connect', address: '192.168.1.40:5555' },
  ]);
  assert.deepEqual(parseMdnsServices('List of discovered mdns services\n'), []);
});

test('the phone Wi-Fi address comes from ip addr or ip route', () => {
  assert.equal(parseWlanAddress('3: wlan0: <BROADCAST,UP>\n    inet 192.168.1.23/24 brd 192.168.1.255 scope global wlan0'), '192.168.1.23');
  assert.equal(parseWlanAddress('192.168.1.0/24 dev wlan0 proto kernel scope link src 192.168.1.23'), '192.168.1.23');
  assert.equal(parseWlanAddress(''), undefined);
});

test('pairing rejects malformed addresses and codes before calling adb', async () => {
  const adb = new Adb('unused');
  await assert.rejects(adb.pair('192.168.1.23', '123456'), /pairing address/);
  await assert.rejects(adb.pair('192.168.1.23:41235', '12a456'), /6-digit/);
});
