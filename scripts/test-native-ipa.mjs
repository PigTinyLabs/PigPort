// Requires an Apple Silicon Mac and an iOS SDK for the test fixture only.
import { execFileSync } from 'node:child_process';
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
