import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { Keymap, parseKeymap } from '../shared/keymap';
import { Adb, locateAdb } from './android/adb';
import { assertAbi, pause } from './android/health';
import { emit, receive, register, requestDialog } from './desktop';
import { iosAppIcon, iosAppsSupported, launchIosApp, listIosApps } from './mac/iosApps';
import { Settings, Store } from './store';
import { avds, configureManagedAndroid, directEmulatorPid, ensureAndroid, managedAndroidDevices } from './runtime/android';
import { NativeIpaRuntime } from './runtime/ipa';
import { AirPlayReceiver } from './airplay';
import { GOOGLE_PLAY_AVD, isManagedProfile, ManagedAndroid, MANAGED_AVD } from './runtime/managedAndroid';
import { moveGameStorage } from './runtime/storage';
import { inspectPackage } from './packages/packages';
import { packageIcon } from './packages/icon';
import { installXapk, matchDeviceAbis } from './android/xapk';
import type { AndroidLaunch, MobilePackage, StorageStatus } from '../shared/api';

const imported = new Map<string, MobilePackage>();

function desktopPath(name: string): string {
  const value = process.env[name];
  if (!value || !path.isAbsolute(value)) throw new Error(`${name} must be an absolute PigPort path.`);
  return value;
}

const resourcesDir = desktopPath('PIGPORT_RESOURCES');
const userData = desktopPath('PIGPORT_USER_DATA');
const store = new Store(userData);
const airplay = new AirPlayReceiver(path.join(resourcesDir, 'airplay'), userData);
let adb = new Adb(locateAdb(undefined, resourcesDir));
const progress = (message: string) => emit('runtime:progress', message);
let storageRoot = userData;
let nativeIpa = new NativeIpaRuntime(path.join(storageRoot, 'ios'), progress);
let managedAndroid = new ManagedAndroid(path.join(storageRoot, 'runtime', 'android'), progress);
const lastBuiltInDevices = new Map<string, string>();
let movingStorage = false;
let runtimeJobs = 0;
let shutdown: Promise<void> | undefined;
const storageJobs = new Set(['packages:install', 'packages:play', 'packages:uninstall', 'runtime:android:prepare',
  'runtime:android:install', 'runtime:android:restart', 'runtime:android:openGooglePlay',
  'adb:install', 'adb:launch', 'adb:uninstall', 'stream:configuration']);

function useStorageRoot(dir: string): void {
  storageRoot = dir;
  nativeIpa = new NativeIpaRuntime(path.join(dir, 'ios'), progress);
  managedAndroid = new ManagedAndroid(path.join(dir, 'runtime', 'android'), progress);
  lastBuiltInDevices.clear();
}

async function storageStatus(): Promise<StorageStatus> {
  const available = storageRoot === userData || await fs.stat(storageRoot).then((stat) => stat.isDirectory(), () => false);
  return { path: storageRoot, available };
}

async function requireGameStorage(): Promise<void> {
  if (!(await storageStatus()).available) throw new Error(`Reconnect the drive that contains PigPort Data at ${storageRoot}.`);
}

async function refreshAdb() {
  const settings = await store.settings();
  const profiles = await managedAndroid.readyAvds();
  configureManagedAndroid(profiles.length ? { sdk: managedAndroid.sdk, avdHome: managedAndroid.avdHome, profiles } : undefined);
  adb = new Adb(locateAdb(settings.adbPath ?? (profiles.length ? managedAndroid.adbPath : undefined), resourcesDir));
  return { settings, profiles, preferred: settings.androidAvd ?? profiles[0] };
}
async function androidDevice(serial?: string): Promise<string> {
  const { settings, preferred } = await refreshAdb();
  return ensureAndroid(adb, serial, preferred, settings.androidGraphics);
}

async function startManagedAndroid(settings: Settings, mode: 'direct' | 'restart', profile: string): Promise<string> {
  if (mode === 'restart') progress('Restarting built-in Android; running Android games will close…');
  try {
    const serial = await ensureAndroid(adb, undefined, profile, settings.androidGraphics, { mode, progress, resolution: settings.androidResolution });
    lastBuiltInDevices.set(serial, profile);
    return serial;
  } finally { progress(''); }
}

async function androidInstallTarget(serial?: string): Promise<string> {
  const { settings, profiles, preferred } = await refreshAdb();
  if (!serial && preferred && isManagedProfile(preferred) && profiles.includes(preferred) && !(await adb.devices()).length) {
    // Open the emulator window on the first boot so the game can play after installation
    // without restarting Android or starting a video stream.
    return startManagedAndroid(settings, 'direct', preferred);
  }
  return ensureAndroid(adb, serial, preferred, settings.androidGraphics);
}

type PlayTarget = AndroidLaunch & { profile?: string };
async function androidPlayback(serial: string | undefined, mode: 'mirror' | undefined, installing: boolean): Promise<PlayTarget> {
  const { settings, profiles, preferred } = await refreshAdb();
  if (profiles.length && mode !== 'mirror') {
    const devices = await adb.devices();
    const ready = devices.filter((device) => device.state === 'device');
    const target = serial || (ready.length === 1 ? ready[0].serial : undefined);
    const builtIn = await managedAndroidDevices(adb, devices);
    const remembered = target && !devices.some((device) => device.serial === target) ? lastBuiltInDevices.get(target) : undefined;
    const name = target ? builtIn.get(target) ?? remembered : devices.length ? undefined : preferred;
    if (name && isManagedProfile(name) && profiles.includes(name)) {
      if (installing) throw new Error('Wait for the current game installation to finish.');
      await requireGameStorage();
      return { serial: await startManagedAndroid(settings, 'direct', name), playback: 'direct', profile: name };
    }
  }
  const selected = await ensureAndroid(adb, serial, preferred, settings.androidGraphics);
  return { serial: selected, playback: 'mirror' };
}

async function saveAndroidDiagnostic(report: string): Promise<string> {
  const dir = path.join(userData, 'diagnostics');
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, 'android-latest.txt');
  await fs.writeFile(file, Buffer.from(report).subarray(-1024 * 1024));
  return file;
}
async function launchAndroid(target: PlayTarget, pkg: string): Promise<AndroidLaunch & { windowPid?: number }> {
  const { serial, playback, profile } = target;
  progress('Opening Android game and checking startup…');
  try { await adb.launch(serial, pkg); }
  catch (error) {
    let report: string;
    try { report = await saveAndroidDiagnostic(await adb.diagnostics(serial, pkg)); }
    catch { report = 'Diagnostic capture failed; check the ADB connection.'; }
    throw new Error((error as Error).message + '\nDiagnostics: ' + report);
  } finally { progress(''); }
  return { serial, playback, windowPid: profile ? await directEmulatorPid(serial, profile) : undefined };
}

function handle<A extends unknown[], R>(channel: string, fn: (...args: A) => Promise<R> | R): void {
  register(channel, async (...args: A) => {
    if (shutdown && channel !== 'app:shutdown') throw new Error('PigPort is closing.');
    if (!storageJobs.has(channel)) return fn(...args);
    if (movingStorage) throw new Error('Wait until PigPort finishes moving game storage.');
    runtimeJobs++;
    try {
      return await fn(...args);
    } finally {
      runtimeJobs--;
    }
  });
}

function registerCommands(): void {
  const saveLibrary = () => store.saveLibrary([...imported.values()]);
  let installing = false;
  // `missing`: the IPA/APK was moved or deleted after it was added to the library.
  handle('packages:list', () => [...imported.values()].map((p) => ({ ...p, missing: !existsSync(p.file) })));
  handle('packages:icon', async (fileOrId: string) => {
    let pkg = imported.get(fileOrId);
    if (!pkg) {
      pkg = [...imported.values()].find((p) => p.bundleId === fileOrId || p.file === fileOrId);
    }
    const targetFile = pkg?.file ?? fileOrId;
    const installedPath = pkg?.kind === 'ipa' && pkg.bundleId ? await nativeIpa.find(pkg.bundleId) : pkg?.installedPath;
    const icon = await packageIcon(targetFile, path.join(userData, 'icon-cache'), installedPath);
    if (!icon) throw new Error('No icon');
    return icon;
  });
  handle('packages:inspect', async (file?: string) => {
    if (installing) throw new Error('Wait for the current installation to finish.');
    if (file !== undefined && (typeof file !== 'string' || !path.isAbsolute(file))) throw new Error('Drop a local IPA, APK, or XAPK file.');
    if (!file) {
      const pick = await requestDialog('open', {
        title: 'Install mobile game', properties: ['openFile'],
        filters: [{ name: 'Mobile packages', extensions: ['ipa', 'apk', 'xapk'] }],
      });
      if (pick.canceled || !pick.filePaths.length) return undefined;
      file = pick.filePaths[0];
    }
    const pkg = await inspectPackage(file);
    imported.set(pkg.file, { ...pkg, status: 'imported' });
    await saveLibrary();
    return imported.get(pkg.file);
  });
  handle('packages:install', async (file: string, serial?: string) => {
    if (installing) throw new Error('Another installation is in progress.');
    const previous = imported.get(file);
    if (!previous) throw new Error('Import the package first.');
    installing = true;
    let pkg = previous;
    try {
      if (pkg.kind !== 'apk') await requireGameStorage();
      pkg = { ...await inspectPackage(file), status: 'installing' };
      imported.set(file, pkg);
      await saveLibrary();
      if (pkg.kind === 'apk' || pkg.kind === 'xapk') {
        if (!pkg.bundleId) throw new Error(`Cannot read ${pkg.kind.toUpperCase()} package ID.`);
        const target = await androidInstallTarget(serial);
        await assertAbi(adb, target, pkg.architectures);
        const presentBefore = (await adb.packages(target)).some((p) => p.id === pkg.bundleId);
        if (!presentBefore) {
          if (pkg.kind === 'xapk') {
            await installXapk(adb, target, file, pkg.bundleId, progress, storageRoot === userData ? undefined : storageRoot);
          } else {
            await adb.install(target, await matchDeviceAbis(adb, target, [file]));
          }
        }
        // Check the exact package rather than guessing by comparing the app list.
        const present = (await adb.packages(target)).some((p) => p.id === pkg.bundleId);
        if (!present) throw new Error('Android did not report the installed package.');
        pkg.serial = target;
        pkg.status = 'installed';
        delete pkg.error;
      } else {
        if (!iosAppsSupported()) throw new Error('IPA games require an Apple Silicon Mac. Local iOS execution is unavailable on Windows.');
        pkg.installedPath = await nativeIpa.install(file, pkg.bundleId!);
        pkg.status = 'installed';
      }
      await saveLibrary();
      return pkg;
    } catch (e) {
      imported.set(file, previous.status === 'installed' ? previous : { ...pkg, status: 'error', error: (e as Error).message });
      await saveLibrary();
      throw e;
    } finally { installing = false; }
  });
  handle('packages:play', async (file: string, serial?: string, mode?: 'mirror') => {
    const pkg = imported.get(file);
    if (!pkg || pkg.status !== 'installed' || !pkg.bundleId) throw new Error('Finish installing this game first.');
    if (pkg.kind === 'ipa') {
      await requireGameStorage();
      // In-game keyboard/mouse controls; the game still runs without them if the layer was not built.
      const library = path.join(resourcesDir, 'ios-input', 'PlayBridgeInput.dylib');
      const input = await fs.access(library).then(() => ({ library, keymap: store.keymapPath(pkg.bundleId!) }), () => undefined);
      await nativeIpa.launch(pkg.bundleId, input);
      return { appId: pkg.bundleId };
    }
    const target = await androidPlayback(serial, mode, installing);
    if (!(await adb.packages(target.serial)).some((p) => p.id === pkg.bundleId)) {
      throw new Error('Game is not installed on this device. Select the original device or install again.');
    }
    await assertAbi(adb, target.serial, pkg.architectures);
    return { ...await launchAndroid(target, pkg.bundleId), appId: pkg.bundleId };
  });
  handle('packages:uninstall', async (file: string, serial?: string) => {
    const pkg = imported.get(file);
    if (!pkg || pkg.status !== 'installed' || !pkg.bundleId) throw new Error('This game is not installed.');
    if (pkg.kind === 'ipa') await requireGameStorage();
    if (installing) throw new Error('Wait for the current installation to finish.');
    const size = pkg.kind === 'ipa' ? await nativeIpa.dataSize(pkg.bundleId) : 0;
    const { response, checkboxChecked: removeEntry } = await requestDialog('message', {
      type: 'question', message: `Uninstall ${pkg.name}?`,
      detail: 'Keep the game data to reinstall without downloading game updates and settings again, or delete it to free space.'
        + (size ? `\n\nGame data: ${(size / 1024 ** 3).toFixed(1)} GB` : '') + '\nDeleting data also deletes this game\'s controls (keymap).',
      buttons: ['Uninstall, keep data', 'Uninstall and delete data', 'Cancel'], defaultId: 0, cancelId: 2,
      checkboxLabel: 'Also remove from library', checkboxChecked: !existsSync(file),
    });
    if (response === 2) return undefined;
    const removeData = response === 1;
    if (pkg.kind === 'ipa') {
      await nativeIpa.uninstall(pkg.bundleId, removeData);
    } else {
      const target = await androidDevice(pkg.serial && (await adb.devices()).some((d) => d.serial === pkg.serial) ? pkg.serial : serial);
      if ((await adb.packages(target)).some((p) => p.id === pkg.bundleId)) await adb.uninstall(target, pkg.bundleId, !removeData);
    }
    if (removeData) await fs.rm(store.keymapPath(pkg.bundleId), { force: true });
    const updated: MobilePackage = { ...pkg, status: 'imported', installedPath: undefined, serial: undefined };
    if (removeEntry) imported.delete(file);
    else imported.set(file, updated);
    await saveLibrary();
    return updated;
  });
  handle('packages:remove', async (file: string) => {
    const pkg = imported.get(file);
    if (!pkg) return false;
    if (pkg.status === 'installed') throw new Error('Uninstall the game first, or tick "Also remove from library" when uninstalling.');
    if (installing && pkg.status === 'installing') throw new Error('Wait for the installation to finish.');
    // A missing file needs no confirmation: there is nothing left to install.
    if (existsSync(file)) {
      const { response } = await requestDialog('message', {
        type: 'question', message: `Remove ${pkg.name} from the library?`,
        detail: `The ${pkg.kind.toUpperCase()} file stays on disk. Drop it here again to add it back.`,
        buttons: ['Remove', 'Cancel'], defaultId: 0, cancelId: 1,
      });
      if (response === 1) return false;
    }
    imported.delete(file);
    await saveLibrary();
    return true;
  });
  handle('runtime:status', async () => {
    const profiles = await managedAndroid.readyAvds();
    return { nativeIpa: await nativeIpa.available(), managedAndroid: profiles.length > 0,
      googlePlay: profiles.includes(GOOGLE_PLAY_AVD), avds: await avds().catch(() => []) };
  });
  handle('runtime:android:restart', async () => {
    await requireGameStorage();
    if (installing) throw new Error('Wait for installation to finish.');
    const { settings, profiles } = await refreshAdb();
    const profile = profiles.find((name) => name === settings.androidAvd) ?? profiles[0];
    if (!profile) throw new Error('Set up built-in Android first.');
    await startManagedAndroid(settings, 'restart', profile);
  });
  handle('runtime:android:prepare', async (profile?: 'googlePlay') => {
    await requireGameStorage();
    return managedAndroid.prepare(profile === 'googlePlay' ? GOOGLE_PLAY_AVD : MANAGED_AVD);
  });
  handle('runtime:android:install', async (token: string, accepted: boolean) => {
    await requireGameStorage();
    if (installing) throw new Error('Wait for the current game installation to finish.');
    await managedAndroid.install(token, accepted);
    await refreshAdb();
  });
  handle('runtime:android:openGooglePlay', async () => {
    await requireGameStorage();
    if (installing) throw new Error('Wait for the current game installation to finish.');
    const { settings, profiles } = await refreshAdb();
    if (!profiles.includes(GOOGLE_PLAY_AVD)) throw new Error('Set up Google Play first.');
    const serial = await startManagedAndroid(settings, 'direct', GOOGLE_PLAY_AVD);
    const result = await launchAndroid({ serial, playback: 'direct', profile: GOOGLE_PLAY_AVD }, 'com.android.vending');
    await store.saveSettings({ ...settings, androidAvd: GOOGLE_PLAY_AVD });
    return result;
  });
  handle('app:info', () => ({ platform: process.platform, iosApps: iosAppsSupported(), version: process.env.PIGPORT_VERSION ?? '' }));
  handle('app:shutdown', () => {
    if (movingStorage || runtimeJobs) throw new Error('Wait for PigPort to finish the current operation before closing.');
    return closeRuntime();
  });

  handle('storage:status', storageStatus);
  handle('storage:choose', async () => {
    if (movingStorage || runtimeJobs) throw new Error('Close games and finish any installations before moving game storage.');
    movingStorage = true;
    try {
      await requireGameStorage();
      const pick = await requestDialog('open', {
        title: 'Choose where to move PigPort game data',
        defaultPath: storageRoot === userData ? undefined : path.dirname(storageRoot),
        properties: ['openDirectory', 'createDirectory'],
      });
      if (pick.canceled || !pick.filePaths[0]) return undefined;
      const current = await fs.realpath(storageRoot);
      const selected = await fs.realpath(pick.filePaths[0]);
      if (selected === current || path.join(selected, 'PigPort Data') === current) {
        return { ...await storageStatus(), remaining: [] };
      }
      await nativeIpa.assertAllStopped();
      if ((await managedAndroid.readyAvds()).length) await managedAndroid.stopRunning(true);
      const result = await moveGameStorage(storageRoot, pick.filePaths[0], async (staging, destination) => {
        await nativeIpa.assertAllStopped();
        await new ManagedAndroid(path.join(staging, 'runtime', 'android'))
          .relocateAvd(new ManagedAndroid(path.join(destination, 'runtime', 'android')));
      }, (destination) => store.saveStoragePath(destination), progress);
      if (result.path !== storageRoot) {
        useStorageRoot(result.path);
        await refreshAdb();
      }
      return { ...await storageStatus(), remaining: result.remaining };
    } finally {
      movingStorage = false;
      progress('');
    }
  });

  handle('settings:get', () => store.settings());
  handle('settings:set', async (s: Settings) => {
    await store.saveSettings(s);
    await refreshAdb();
  });

  handle('adb:status', async () => {
    try {
      await refreshAdb();
      return { ok: true, binary: adb.binary, version: await adb.version() };
    } catch (e) {
      return { ok: false, binary: adb.binary, error: (e as Error).message };
    }
  });
  handle('adb:devices', async () => {
    const devices = await adb.devices();
    const builtin = await managedAndroidDevices(adb, devices);
    for (const [serial, profile] of builtin) lastBuiltInDevices.set(serial, profile);
    return devices.map((device) => {
      const profile = builtin.get(device.serial);
      return profile ? { ...device, avd: profile, googlePlay: profile === GOOGLE_PLAY_AVD } : device;
    });
  });
  handle('adb:wireless', () => adb.wireless());
  handle('adb:pair', async (address: string, code: string) => {
    const paired = await adb.pair(address, code);
    // The phone then advertises a connect address on the same IP (different port); use it.
    const host = address.replace(/:\d+$/, '');
    for (let attempt = 0; attempt < 8; attempt++) {
      const devices = await adb.devices();
      if (devices.some((d) => d.state === 'device' && d.serial.startsWith(host + ':'))) return paired;
      const service = (await adb.wireless()).find((s) => s.kind === 'connect' && s.address.startsWith(host + ':'));
      if (service) return `${paired}\n${await adb.connect(service.address)}`;
      await pause(1000);
    }
    return `${paired}\nNow tap Connect with the IP address & port shown under Wireless debugging.`;
  });
  handle('adb:enableWifi', (serial: string) => adb.enableWifi(serial));
  handle('adb:connect', (address: string) => adb.connect(address));
  handle('adb:packages', (serial: string) => adb.packages(serial));
  handle('adb:install', async (serial: string) => {
    const pick = await requestDialog('open', {
      title: 'Install APK / XAPK',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Android packages', extensions: ['apk', 'xapk'] }],
    });
    if (pick.canceled || pick.filePaths.length === 0) return false;
    if (pick.filePaths.length === 1 && pick.filePaths[0].toLowerCase().endsWith('.xapk')) {
      await requireGameStorage();
      const pkg = await inspectPackage(pick.filePaths[0]);
      if (!pkg.bundleId) throw new Error('Cannot read XAPK package ID.');
      await installXapk(adb, serial, pick.filePaths[0], pkg.bundleId, progress, storageRoot === userData ? undefined : storageRoot);
      return true;
    }
    await adb.install(serial, pick.filePaths);
    return true;
  });
  handle('adb:uninstall', (serial: string, pkg: string) => adb.uninstall(serial, pkg));
  handle('adb:launch', async (serial: string, pkg: string, mode?: 'mirror') =>
    launchAndroid(await androidPlayback(serial, mode, installing), pkg));
  handle('adb:diagnostics', async (serial: string, pkg: string) => {
    const report = await adb.diagnostics(serial, pkg);
    return saveAndroidDiagnostic(report);
  });
  handle('adb:forceStop', (serial: string, pkg: string) => adb.forceStop(serial, pkg));

  handle('airplay:status', () => airplay.status());
  handle('airplay:start', () => airplay.start());
  handle('airplay:stop', () => airplay.stop());
  airplay.on('status', () => void airplay.status().then((s) => emit('airplay:status', s)).catch(() => undefined));
  handle('ios:list', () => listIosApps());
  handle('ios:launch', (appPath: string) => launchIosApp(appPath));
  handle('ios:icon', async (appPath: string) => {
    const icon = await iosAppIcon(appPath, path.join(userData, 'icon-cache'));
    if (!icon) throw new Error('No icon');
    return icon;
  });

  handle('keymap:load', (appId: string) => store.keymap(appId));
  handle('keymap:save', (appId: string, map: Keymap) => store.saveKeymap(appId, map));
  handle('keymap:export', async (appId: string, map: Keymap) => {
    const pick = await requestDialog('save', {
      defaultPath: `${appId}.keymap.json`,
      filters: [{ name: 'Keymap', extensions: ['json'] }],
    });
    if (pick.canceled || !pick.filePath) return false;
    await fs.writeFile(pick.filePath, JSON.stringify(map, null, 2));
    return true;
  });
  handle('keymap:import', async () => {
    const pick = await requestDialog('open', {
      properties: ['openFile'],
      filters: [{ name: 'Keymap', extensions: ['json'] }],
    });
    if (pick.canceled || pick.filePaths.length === 0) return undefined;
    return parseKeymap(await fs.readFile(pick.filePaths[0], 'utf8'));
  });

  handle('stream:configuration', async () => {
    const { settings } = await refreshAdb();
    return { adbPath: adb.binary, options: settings.stream };
  });
}

function closeRuntime(): Promise<void> {
  shutdown ??= (async () => {
    airplay.stop();
    // Keep the managed runtime alive on macOS, as in the previous desktop host.
    if (process.platform !== 'darwin') await managedAndroid.stopRunning();
  })();
  return shutdown;
}

void (async () => {
  useStorageRoot(await store.storagePath() ?? userData);
  await refreshAdb();
  for (const pkg of await store.library()) imported.set(pkg.file, pkg);
  registerCommands();
  receive(closeRuntime);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
