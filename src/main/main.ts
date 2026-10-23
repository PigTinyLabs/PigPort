import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { existsSync, readFileSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { Keymap, parseKeymap } from '../shared/keymap';
import { Adb, locateAdb } from './android/adb';
import { assertAbi, waitForAndroid, pause } from './android/health';
import { KEYCODE_APP_SWITCH, KEYCODE_BACK, KEYCODE_HOME, ScrcpySession } from './android/scrcpy';
import { iosAppIcon, iosAppsSupported, launchIosApp, listIosApps } from './mac/iosApps';
import { Settings, Store } from './store';
import { avds, ensureAndroid, configureManagedAndroid } from './runtime/android';
import { NativeIpaRuntime } from './runtime/ipa';
import { ManagedAndroid, MANAGED_AVD } from './runtime/managedAndroid';
import { inspectPackage } from './packages/packages';
import { packageIcon } from './packages/icon';
import { installXapk, matchDeviceAbis } from './android/xapk';
import type { MobilePackage } from '../shared/api';

const imported = new Map<string, MobilePackage>();

const resourcesDir = app.isPackaged
  ? process.resourcesPath
  : path.join(__dirname, '..', '..', 'resources');

// Renamed from PlayBridge: keep the existing library, installed games and keymaps.
app.setPath('userData', path.join(app.getPath('appData'), 'PlayBridge'));
const store = new Store(app.getPath('userData'));
let adb = new Adb(locateAdb(undefined, resourcesDir));
let session: ScrcpySession | undefined;
let win: BrowserWindow | undefined;
const progress = (message: string) => win?.webContents.send('runtime:progress', message);
const nativeIpa = new NativeIpaRuntime(path.join(app.getPath('userData'), 'ios'), progress);
const managedAndroid = new ManagedAndroid(path.join(app.getPath('userData'), 'runtime/android'), progress);
async function refreshAdb(): Promise<void> {
  const settings = await store.settings();
  const ready = await managedAndroid.ready();
  if (ready) configureManagedAndroid(managedAndroid.sdk, managedAndroid.avdHome);
  adb = new Adb(locateAdb(settings.adbPath ?? (ready ? managedAndroid.adbPath : undefined), resourcesDir));
}
async function androidDevice(serial?: string): Promise<string> {
  const settings = await store.settings();
  return ensureAndroid(adb, serial, settings.androidAvd ?? (await managedAndroid.ready() ? MANAGED_AVD : undefined), settings.androidGraphics);
}

async function saveAndroidDiagnostic(report: string): Promise<string> {
  const dir = path.join(app.getPath('userData'), 'diagnostics');
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, 'android-latest.txt');
  await fs.writeFile(file, Buffer.from(report).subarray(-1024 * 1024));
  return file;
}
async function launchAndroid(serial: string, pkg: string): Promise<void> {
  progress('Opening Android game and checking startup…');
  try { await adb.launch(serial, pkg); }
  catch (error) {
    let report: string;
    try { report = await saveAndroidDiagnostic(await adb.diagnostics(serial, pkg)); }
    catch { report = 'Diagnostic capture failed; check the ADB connection.'; }
    throw new Error((error as Error).message + '\nDiagnostics: ' + report);
  } finally { progress(''); }
}

function scrcpyServer(): { jar: string; version: string } {
  const jar = path.join(resourcesDir, 'scrcpy-server');
  const versionFile = path.join(resourcesDir, 'scrcpy-server.version');
  if (!existsSync(jar) || !existsSync(versionFile)) {
    throw new Error('scrcpy-server is missing. Run "npm run fetch:scrcpy-server" (see README).');
  }
  return { jar, version: readFileSync(versionFile, 'utf8').trim() };
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 560,
    title: 'PigPort',
    icon: path.join(__dirname, '..', 'web', 'renderer', 'logo.png'),
    backgroundColor: '#111317',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.removeMenu();
  void win.loadFile(path.join(__dirname, '..', 'web', 'renderer', 'index.html'));
  win.on('closed', () => {
    session?.stop();
    win = undefined;
  });
}

function handle<A extends unknown[], R>(channel: string, fn: (...args: A) => Promise<R> | R): void {
  ipcMain.handle(channel, (_e, ...args) => fn(...(args as A)));
}

function registerIpc(): void {
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
    const icon = await packageIcon(targetFile, path.join(app.getPath('userData'), 'icon-cache'), pkg?.installedPath);
    if (!icon) throw new Error('No icon');
    return icon;
  });
  handle('packages:inspect', async (file?: string) => {
    if (installing) throw new Error('Wait for the current installation to finish.');
    if (file !== undefined && (typeof file !== 'string' || !path.isAbsolute(file))) throw new Error('Drop a local IPA, APK, or XAPK file.');
    if (!file) {
      const pick = await dialog.showOpenDialog(win!, {
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
    if (!imported.has(file)) throw new Error('Import the package first.');
    installing = true;
    let pkg = imported.get(file)!;
    try {
      pkg = { ...await inspectPackage(file), status: 'installing' };
      imported.set(file, pkg);
      await saveLibrary();
      if (pkg.kind === 'apk' || pkg.kind === 'xapk') {
        if (!pkg.bundleId) throw new Error(`Cannot read ${pkg.kind.toUpperCase()} package ID.`);
        const target = await androidDevice(serial);
        await assertAbi(adb, target, pkg.architectures);
        if (pkg.kind === 'xapk') {
          await installXapk(adb, target, file, pkg.bundleId, progress);
        } else {
          await adb.install(target, await matchDeviceAbis(adb, target, [file]));
        }
        // Check the exact package rather than guessing by comparing the app list.
        const present = (await adb.packages(target)).some((p) => p.id === pkg.bundleId);
        if (!present) throw new Error('Android did not report the installed package.');
        pkg.serial = target;
        pkg.status = 'installed';
      } else {
        if (!iosAppsSupported()) throw new Error('IPA games require an Apple Silicon Mac. Local iOS execution is unavailable on Windows.');
        pkg.installedPath = await nativeIpa.install(file, pkg.bundleId!);
        pkg.status = 'installed';
      }
      await saveLibrary();
      return pkg;
    } catch (e) {
      pkg.status = 'error'; pkg.error = (e as Error).message;
      imported.set(file, pkg);
      await saveLibrary();
      throw e;
    } finally { installing = false; }
  });
  handle('packages:play', async (file: string, serial?: string) => {
    const pkg = imported.get(file);
    if (!pkg || pkg.status !== 'installed' || !pkg.bundleId) throw new Error('Finish installing this game first.');
    if (pkg.kind === 'ipa') {
      // In-game keyboard/mouse controls; the game still runs without them if the layer was not built.
      const library = path.join(resourcesDir, 'ios-input', 'PlayBridgeInput.dylib');
      const input = await fs.access(library).then(() => ({ library, keymap: store.keymapPath(pkg.bundleId!) }), () => undefined);
      await nativeIpa.launch(pkg.bundleId, input);
      return { appId: pkg.bundleId };
    }
    const target = await androidDevice(serial);
    if (!(await adb.packages(target)).some((p) => p.id === pkg.bundleId)) throw new Error('Game is not installed on this device. Select the original device or install again.');
    await assertAbi(adb, target, pkg.architectures);
    await launchAndroid(target, pkg.bundleId);
    return { appId: pkg.bundleId, serial: target };
  });
  handle('packages:uninstall', async (file: string, serial?: string) => {
    const pkg = imported.get(file);
    if (!pkg || pkg.status !== 'installed' || !pkg.bundleId) throw new Error('This game is not installed.');
    if (installing) throw new Error('Wait for the current installation to finish.');
    const size = pkg.kind === 'ipa' ? await nativeIpa.dataSize(pkg.bundleId) : 0;
    const { response, checkboxChecked: removeEntry } = await dialog.showMessageBox(win!, {
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
      const { response } = await dialog.showMessageBox(win!, {
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
  handle('runtime:status', async () => ({ nativeIpa: await nativeIpa.available(), managedAndroid: await managedAndroid.ready(), avds: await avds().catch(() => []) }));
  handle('runtime:android:restart', async () => {
    if (installing) throw new Error('Wait for installation to finish.');
    if (!await managedAndroid.ready()) throw new Error('Set up built-in Android first.');
    progress('Restarting built-in Android; running Android games will close…');
    try {
      for (const device of await adb.devices()) {
        if (!device.serial.startsWith('emulator-')) continue;
        const name = (await adb.run(['-s', device.serial, 'emu', 'avd', 'name'], 5000)).split(/\r?\n/)[0].trim();
        if (name !== MANAGED_AVD) continue;
        await adb.run(['-s', device.serial, 'emu', 'kill'], 10000);
        const deadline = Date.now() + 30000;
        while ((await adb.devices()).some((d) => d.serial === device.serial)) {
          if (Date.now() >= deadline) throw new Error('Android did not stop. Close the emulator before retrying.');
          await pause(500);
        }
      }
      await ensureAndroid(adb, undefined, MANAGED_AVD, (await store.settings()).androidGraphics, true);
    } finally { progress(''); }
  });
  handle('runtime:android:prepare', () => managedAndroid.prepare());
  handle('runtime:android:install', async (token: string, accepted: boolean) => {
    if (installing) throw new Error('Wait for the current game installation to finish.');
    await managedAndroid.install(token, accepted);
    await refreshAdb();
  });
  handle('app:info', () => ({ platform: process.platform, iosApps: iosAppsSupported(), version: app.getVersion() }));

  handle('settings:get', () => store.settings());
  handle('settings:set', async (s: Settings) => {
    await store.saveSettings(s);
    await refreshAdb();
  });

  handle('adb:status', async () => {
    try {
      return { ok: true, binary: adb.binary, version: await adb.version() };
    } catch (e) {
      return { ok: false, binary: adb.binary, error: (e as Error).message };
    }
  });
  handle('adb:devices', () => adb.devices());
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
    const pick = await dialog.showOpenDialog(win!, {
      title: 'Install APK / XAPK',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Android packages', extensions: ['apk', 'xapk'] }],
    });
    if (pick.canceled || pick.filePaths.length === 0) return false;
    if (pick.filePaths.length === 1 && pick.filePaths[0].toLowerCase().endsWith('.xapk')) {
      const pkg = await inspectPackage(pick.filePaths[0]);
      if (!pkg.bundleId) throw new Error('Cannot read XAPK package ID.');
      await installXapk(adb, serial, pick.filePaths[0], pkg.bundleId, progress);
      return true;
    }
    await adb.install(serial, pick.filePaths);
    return true;
  });
  handle('adb:uninstall', (serial: string, pkg: string) => adb.uninstall(serial, pkg));
  handle('adb:launch', async (serial: string, pkg: string) => { await waitForAndroid(adb, serial); await launchAndroid(serial, pkg); });
  handle('adb:diagnostics', async (serial: string, pkg: string) => {
    const report = await adb.diagnostics(serial, pkg);
    return saveAndroidDiagnostic(report);
  });
  handle('adb:forceStop', (serial: string, pkg: string) => adb.forceStop(serial, pkg));

  handle('ios:list', () => listIosApps());
  handle('ios:launch', (appPath: string) => launchIosApp(appPath));
  handle('ios:icon', async (appPath: string) => {
    const icon = await iosAppIcon(appPath, path.join(app.getPath('userData'), 'icon-cache'));
    if (!icon) throw new Error('No icon');
    return icon;
  });

  handle('keymap:load', (appId: string) => store.keymap(appId));
  handle('keymap:save', (appId: string, map: Keymap) => store.saveKeymap(appId, map));
  handle('keymap:export', async (appId: string, map: Keymap) => {
    const pick = await dialog.showSaveDialog(win!, {
      defaultPath: `${appId}.keymap.json`,
      filters: [{ name: 'Keymap', extensions: ['json'] }],
    });
    if (pick.canceled || !pick.filePath) return false;
    await fs.writeFile(pick.filePath, JSON.stringify(map, null, 2));
    return true;
  });
  handle('keymap:import', async () => {
    const pick = await dialog.showOpenDialog(win!, {
      properties: ['openFile'],
      filters: [{ name: 'Keymap', extensions: ['json'] }],
    });
    if (pick.canceled || pick.filePaths.length === 0) return undefined;
    return parseKeymap(await fs.readFile(pick.filePaths[0], 'utf8'));
  });

  handle('stream:start', async (serial: string) => {
    session?.stop();
    const { jar, version } = scrcpyServer();
    const s = new ScrcpySession(adb, serial, jar, version, (await store.settings()).stream);
    session = s;
    const send = (channel: string, payload: unknown) => {
      if (session === s) win?.webContents.send(channel, payload);
    };
    s.on('meta', (m) => send('stream:meta', m));
    s.on('packet', (p) => send('stream:packet', p));
    s.on('log', (l) => send('stream:log', l));
    s.on('closed', (reason) => {
      send('stream:closed', reason);
      if (session === s) session = undefined;
    });
    await s.start();
  });
  handle('stream:stop', () => session?.stop());

  // Input is fire-and-forget: no round trip per touch.
  ipcMain.on('stream:touch', (_e, action: number, id: number, x: number, y: number, w: number, h: number) => {
    session?.touch(action, id, x, y, w, h);
  });
  ipcMain.on('stream:nav', (_e, button: 'back' | 'home' | 'recents') => {
    session?.key({ back: KEYCODE_BACK, home: KEYCODE_HOME, recents: KEYCODE_APP_SWITCH }[button]);
  });
}

app.whenReady().then(async () => {
  // Packaged builds take the icon from the bundle; `npm start` would show Electron's.
  if (!app.isPackaged) app.dock?.setIcon(path.join(__dirname, '..', 'web', 'renderer', 'logo.png'));
  await refreshAdb();
  for (const pkg of await store.library()) imported.set(pkg.file, pkg);
  registerIpc();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  session?.stop();
  if (process.platform !== 'darwin') app.quit();
});
