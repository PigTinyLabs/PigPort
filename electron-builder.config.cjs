// Packaging and code signing. See README → Đóng gói và ký.
//
// macOS
// - With a Developer ID Application certificate (CSC_LINK + CSC_KEY_PASSWORD, CSC_NAME, or one in
//   the keychain) the app is signed with the hardened runtime, and notarized when Apple credentials
//   are set (APPLE_API_KEY + APPLE_API_KEY_ID + APPLE_API_ISSUER, or APPLE_ID +
//   APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID). Downloads then open without warnings.
// - Without one, the whole bundle is ad-hoc signed so its signature is complete and valid. Gatekeeper
//   still asks the user to allow it (System Settings → Privacy & Security → Open Anyway).
// Windows
// - Signed when WIN_CSC_LINK (or CSC_LINK) + WIN_CSC_KEY_PASSWORD are set; otherwise unsigned and
//   SmartScreen shows "Windows protected your PC" until the user picks "Run anyway".
const { execFileSync } = require('node:child_process');

function macCertificateAvailable() {
  if (process.env.CSC_LINK || process.env.CSC_NAME) return true;
  if (process.platform !== 'darwin') return false;
  try {
    return execFileSync('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning'], { encoding: 'utf8' }).includes('Developer ID Application');
  } catch {
    return false;
  }
}

const signed = macCertificateAvailable();
if (process.platform === 'darwin' && !signed) console.log('No Developer ID certificate found: ad-hoc signing the macOS app (not notarized).');

module.exports = {
  appId: 'com.pigtinylabs.pigport',
  productName: 'PigPort',
  artifactName: '${productName}-${version}-${os}-${arch}.${ext}',
  files: ['dist/main/**', 'dist/preload/**', 'dist/shared/**', 'dist/web/**', '!dist/test/**', '!**/*.map'],
  extraResources: [
    { from: 'resources', to: '.', filter: ['scrcpy-server', 'scrcpy-server.version', 'platform-tools/**', 'ios-input/**'] },
  ],
  mac: {
    // Apple silicon and Intel builds. iOS games need Apple silicon; Intel Macs get Android games.
    target: [{ target: 'dmg', arch: ['arm64', 'x64'] }, { target: 'zip', arch: ['arm64', 'x64'] }],
    category: 'public.app-category.games',
    // The ad-hoc identity "-" cannot satisfy hardened-runtime library validation for Electron's
    // pre-signed frameworks, so the hardened runtime is only used with a real certificate.
    ...(signed
      ? { hardenedRuntime: true, entitlements: 'build/entitlements.mac.plist', entitlementsInherit: 'build/entitlements.mac.plist' }
      : { identity: '-', hardenedRuntime: false }),
  },
  win: {
    target: ['nsis', 'portable'],
  },
  nsis: {
    oneClick: false,
    allowToChangeInstallationDirectory: true,
  },
  directories: {
    output: 'release',
  },
};
