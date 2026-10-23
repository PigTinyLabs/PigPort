// Requires an Apple Silicon Mac and an iOS SDK for the test fixture only.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { NativeIpaRuntime } = require('../dist/main/runtime/ipa.js');
if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('This integration check needs an Apple Silicon Mac.');
const developer = process.env.DEVELOPER_DIR || '/Applications/Xcode.app/Contents/Developer';
const sdk = path.join(developer, 'Platforms/iPhoneOS.platform/Developer/SDKs/iPhoneOS.sdk');
const clang = path.join(developer, 'Toolchains/XcodeDefault.xctoolchain/usr/bin/clang');
if (!existsSync(sdk) || !existsSync(clang)) throw new Error('Install Xcode to compile the UIKit test fixture. End users do not need Xcode.');
const work = mkdtempSync(path.join(tmpdir(), 'playbridge-ipa-'));
try {
  const payload = path.join(work, 'Payload'), bundle = path.join(payload, 'Demo.app'); mkdirSync(bundle, { recursive: true });
  const frameworks = path.join(bundle, 'Frameworks'), helper = path.join(frameworks, 'Helper.framework'); mkdirSync(helper, { recursive: true });
  writeFileSync(path.join(work, 'helper.c'), 'int BridgeAnswer(void) { return 42; }');
  writeFileSync(path.join(helper, 'Info.plist'), '<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>io.playbridge.fixture.helper</string><key>CFBundleExecutable</key><string>Helper</string><key>CFBundlePackageType</key><string>FMWK</string></dict></plist>');
  // A NetEase-style resource-only bundle: no Info.plist or executable.
  const webResources = path.join(helper, 'NgWebViewSDK.bundle'); mkdirSync(webResources);
  writeFileSync(path.join(webResources, 'ngwebview_clean_env.html'), '<html>resource bundle fixture</html>');
  execFileSync(clang, ['-target', 'arm64-apple-ios15.0', '-isysroot', sdk, '-dynamiclib', '-install_name', '@rpath/Helper.framework/Helper', path.join(work, 'helper.c'), '-o', path.join(helper, 'Helper')]);
  execFileSync(clang, ['-DPLAYBRIDGE_WITH_HELPER', '-F', frameworks, '-framework', 'Helper', '-Wl,-rpath,@executable_path/Frameworks', '-target', 'arm64-apple-ios15.0', '-isysroot', sdk, '-fobjc-arc', '-framework', 'UIKit', '-framework', 'Foundation', path.resolve('src/test/fixtures/UIKitDemo.m'), '-o', path.join(bundle, 'Demo')]);
  writeFileSync(path.join(bundle, 'Info.plist'), '<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>io.playbridge.fixture</string><key>CFBundleExecutable</key><string>Demo</string><key>CFBundleName</key><string>Demo</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleVersion</key><string>1</string></dict></plist>');
  const ipa = path.join(work, 'Demo.ipa'); execFileSync('/usr/bin/ditto', ['-c', '-k', '--keepParent', payload, ipa]);
  const runtime = new NativeIpaRuntime(path.join(work, 'runtime'), console.log);
  const installed = await runtime.install(ipa, 'io.playbridge.fixture');
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', installed]);
  assert.equal(readFileSync(path.join(installed, 'Frameworks/Helper.framework/NgWebViewSDK.bundle/ngwebview_clean_env.html'), 'utf8'), '<html>resource bundle fixture</html>');
  const output = execFileSync(path.join(installed, 'Demo'), ['--self-test'], { encoding: 'utf8' });
  assert.match(output, /UIKit loaded: YES/); assert.match(output, /Nested framework answer: 42/);
  const dylib = path.resolve('resources/ios-input/PlayBridgeInput.dylib');
  const ipadSpoof = execFileSync(path.join(installed, 'Demo'), ['--check-spoofing'], {
    encoding: 'utf8',
    env: { ...process.env, DYLD_INSERT_LIBRARIES: dylib }
  });
  assert.match(ipadSpoof, /machine: iPad13,8/);
  assert.match(ipadSpoof, /uts\.machine: iPad13,8/);
  assert.match(ipadSpoof, /catalyst: NO/);
  assert.match(ipadSpoof, /iosOnMac: NO/);
  assert.match(ipadSpoof, /model: iPad/);
  assert.match(ipadSpoof, /idiom: 1/);

  const iphoneSpoof = execFileSync(path.join(installed, 'Demo'), ['--check-spoofing'], {
    encoding: 'utf8',
    env: { ...process.env, DYLD_INSERT_LIBRARIES: dylib, PLAYBRIDGE_DEVICE_TYPE: 'iphone' }
  });
  assert.match(iphoneSpoof, /machine: iPhone14,2/);
  assert.match(iphoneSpoof, /uts\.machine: iPhone14,2/);
  assert.match(iphoneSpoof, /catalyst: NO/);
  assert.match(iphoneSpoof, /iosOnMac: NO/);
  assert.match(iphoneSpoof, /model: iPhone/);
  assert.match(iphoneSpoof, /idiom: 0/);
  console.log('PASS: iOS environment spoofing verified (iPad & iPhone emulation, catalyst=NO, isiOSAppOnMac=NO).');

  // Quitting must end the game even though exit() is swallowed during play (2026-10-22: a NeoX game stuck in its
  // exit loop wrote 64 GB of log and filled the disk).
  const demo = path.join(installed, 'Demo');
  const injected = (extra = {}) => ({ ...process.env, DYLD_INSERT_LIBRARIES: dylib, ...extra });
  const quit = spawnSync(demo, ['--check-exit', 'quit'], { encoding: 'utf8', env: injected(), timeout: 20000 });
  assert.equal(quit.status, 7, `quit: status ${quit.status} signal ${quit.signal}`);
  assert.match(quit.stdout, /exit blocked/); assert.doesNotMatch(quit.stdout, /NOT REACHED/);
  const t0 = Date.now();
  const hang = spawnSync(demo, ['--check-exit', 'hang'], { encoding: 'utf8', env: injected(), timeout: 20000 });
  const hangSeconds = (Date.now() - t0) / 1000;
  assert.equal(hang.status, 0, `hang: status ${hang.status} signal ${hang.signal}`);
  assert.ok(hangSeconds >= 4 && hangSeconds < 12, `hang ended after ${hangSeconds}s, expected ~5s`);
  const loopExit = async (extraEnv, sendSigterm) => {
    const child = spawn(demo, ['--check-exit', 'loop'], { env: injected(extraEnv) });
    let out = ''; child.stdout.on('data', (d) => { out += d; });
    const done = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
    while (!out.includes('ready') && child.exitCode === null) await new Promise((r) => setTimeout(r, 50));
    await new Promise((r) => setTimeout(r, 1000));
    const stillRunning = child.exitCode === null;
    if (sendSigterm) child.kill('SIGTERM');
    const t = Date.now();
    const result = await Promise.race([done, new Promise((r) => setTimeout(() => r({ timeout: true }), 15000))]);
    if (result.timeout) child.kill('SIGKILL');
    return { ...result, stillRunning, seconds: (Date.now() - t) / 1000 };
  };
  const term = await loopExit({}, true);
  assert.ok(term.stillRunning, 'exit() during play must stay swallowed');
  assert.equal(term.code, 9, `SIGTERM: ${JSON.stringify(term)}`); assert.ok(term.seconds < 3, `SIGTERM took ${term.seconds}s`);
  const lowDisk = await loopExit({ PLAYBRIDGE_MIN_FREE_MB: String(1024 ** 3) }, false);
  assert.equal(lowDisk.code, 9, `low disk: ${JSON.stringify(lowDisk)}`);
  console.log('PASS: clean shutdown (exit swallowed during play; allowed when quitting; stuck exit forced after 5 s; SIGTERM; low-disk stop).');
  const again = await runtime.install(ipa, 'io.playbridge.fixture'); assert.equal(again, installed);
  const installedBinary = path.join(installed, 'Demo');
  const before = createHash('sha256').update(readFileSync(installedBinary)).digest('hex');
  const invalid = readFileSync(path.join(bundle, 'Demo')); invalid.writeUInt32LE(2, 8); writeFileSync(path.join(bundle, 'Demo'), invalid);
  const invalidIpa = path.join(work, 'Invalid.ipa'); execFileSync('/usr/bin/ditto', ['-c', '-k', '--keepParent', payload, invalidIpa]);
  await assert.rejects(runtime.install(invalidIpa, 'io.playbridge.fixture'), /arm64e/);
  assert.equal(createHash('sha256').update(readFileSync(installedBinary)).digest('hex'), before);
  console.log('PASS: real iOS UIKit binary → IPA → native install → code signature → UIKit load → nested framework + resource-only bundle → reinstall → failed update preserves existing game.');
  console.log('This headless check does not verify a game window or game compatibility.');
} finally { rmSync(work, { recursive: true, force: true }); }
