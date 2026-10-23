// Compiles the input layer that PlayBridge injects into iOS games (Mac Catalyst).
// Needs Command Line Tools on the build machine only; end users get the prebuilt dylib.
// On other platforms, or without clang, the app still builds and runs IPA games
// without keyboard/mouse controls.
import { execFileSync } from 'node:child_process';
import { mkdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'src/native/ios-input/PlayBridgeInput.m');
const out = path.join(root, 'resources/ios-input/PlayBridgeInput.dylib');

if (process.platform !== 'darwin') process.exit(0);
const mtime = (file) => { try { return statSync(file).mtimeMs; } catch { return 0; } };
if (mtime(out) > mtime(source) && !process.argv.includes('--force')) process.exit(0);

let sdk;
try {
  sdk = execFileSync('/usr/bin/xcrun', ['--sdk', 'macosx', '--show-sdk-path'], { encoding: 'utf8' }).trim();
} catch {
  console.warn('warning: macOS SDK not found (install Command Line Tools); iOS game controls will be unavailable.');
  process.exit(0);
}
const frameworks = path.join(sdk, 'System/iOSSupport/System/Library/Frameworks');
mkdirSync(path.dirname(out), { recursive: true });
execFileSync('/usr/bin/xcrun', ['clang', '-target', 'arm64-apple-ios15.0-macabi', '-isysroot', sdk, '-iframework', frameworks,
  '-fobjc-arc', '-O2', '-Wall', '-Wno-deprecated-declarations', '-dynamiclib', '-install_name', '@rpath/PlayBridgeInput.dylib',
  '-framework', 'UIKit', '-framework', 'Foundation', '-framework', 'CoreGraphics', '-framework', 'QuartzCore', '-framework', 'GameController', '-framework', 'IOKit', '-framework', 'Security', source, '-o', out], { stdio: 'inherit' });
execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', out], { stdio: 'inherit' });
console.log('Built', path.relative(root, out));
