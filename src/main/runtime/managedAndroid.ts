import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs, existsSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { downloadText, downloadVerified } from './download';
import { latestPackage, repositoryPackages, RuntimePackage } from './repository';
import type { RuntimePlan } from '../../shared/api';
const execute = promisify(execFile);
const BASE = 'https://dl.google.com/android/repository/';
export const MANAGED_AVD = 'PlayBridge_Android_35';

export class ManagedAndroid {
  private plan?: { public: RuntimePlan; packages: RuntimePackage[] };
  private working = false;
  constructor(readonly root: string, private progress: (message: string) => void = () => undefined) {}
  get sdk(): string { return path.join(this.root, 'sdk'); }
  get avdHome(): string { return path.join(this.root, 'avd'); }
  get abi(): string {
    if (process.platform === 'darwin' && process.arch === 'arm64') return 'arm64-v8a';
    if ((process.platform === 'win32' || process.platform === 'darwin') && process.arch === 'x64') return 'x86_64';
    throw new Error('Managed Android currently supports Apple Silicon/Intel Mac and x64 Windows.');
  }
  /** x86_64 needs the Google APIs image: only it ships ARM translation (libndk_translation) for arm64-only games. */
  get tag(): string { return this.abi === 'x86_64' ? 'google_apis' : 'default'; }
  get imageId(): string { return `system-images;android-35;${this.tag};${this.abi}`; }
  private imageDir(sdk: string): string { return path.join(sdk, 'system-images', 'android-35', this.tag, this.abi); }
  get adbPath(): string { return path.join(this.sdk, 'platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb'); }
  async ready(): Promise<boolean> {
    const marker = await fs.readFile(path.join(this.root, 'installed.json'), 'utf8').catch(() => '');
    try {
      const saved = JSON.parse(marker);
      return saved.imageId === this.imageId && existsSync(this.adbPath)
        && existsSync(path.join(this.sdk, 'emulator', process.platform === 'win32' ? 'emulator.exe' : 'emulator'))
        && existsSync(path.join(this.imageDir(this.sdk), 'system.img'))
        && existsSync(path.join(this.avdHome, MANAGED_AVD + '.ini'));
    } catch { return false; }
  }
  async prepare(): Promise<RuntimePlan> {
    if (this.working) throw new Error('Android setup is already in progress.');
    const host = process.platform === 'darwin' ? 'macosx' : process.platform === 'win32' ? 'windows' : undefined;
    if (!host) throw new Error('Managed Android supports macOS and Windows.');
    this.progress('Reading official Android runtime packages…');
    const imageBase = `${BASE}sys-img/${this.tag === 'default' ? 'android' : this.tag}/`;
    const [sdkXml, imageXml] = await Promise.all([downloadText(BASE + 'repository2-3.xml'), downloadText(imageBase + 'sys-img2-3.xml')]);
    const sdkPackages = repositoryPackages(sdkXml, BASE, host, process.arch);
    const imagePackages = repositoryPackages(imageXml, imageBase, host, process.arch);
    const packages = [latestPackage(sdkPackages, 'platform-tools'), latestPackage(sdkPackages, 'emulator'), latestPackage(imagePackages, this.imageId)];
    const licenses = [...new Map(packages.map((p) => [p.licenseId, { id: p.licenseId, text: p.licenseText }])).values()];
    const plan: RuntimePlan = { token: randomUUID(), bytes: packages.reduce((n, p) => n + p.size, 0), licenses, packages: packages.map((p) => p.id) };
    this.plan = { public: plan, packages }; return plan;
  }
  async install(token: string, accepted: boolean): Promise<void> {
    if (this.working) throw new Error('Android setup is already in progress.');
    if (!this.plan || this.plan.public.token !== token || accepted !== true) throw new Error('Review and accept the displayed Android terms before installation.');
    const plan = this.plan; this.plan = undefined; this.working = true;
    let stage: string | undefined;
    let switched = false, backupSdk: string | undefined;
    try {
      await fs.mkdir(this.root, { recursive: true });
      const disk = await fs.statfs(this.root);
      const needed = plan.public.bytes * 3 + 8 * 1024 ** 3;
      if (disk.bavail * disk.bsize < needed) throw new Error(`Android setup needs about ${Math.ceil(needed / 1024 ** 3)} GiB free disk space.`);
      stage = await fs.mkdtemp(path.join(this.root, 'setup-'));
      const sdkStage = path.join(stage, 'sdk'); await fs.mkdir(sdkStage);
      for (const pkg of plan.packages) {
        const zip = path.join(stage, randomUUID() + '.zip'), unpack = path.join(stage, randomUUID());
        await downloadVerified(pkg.url, zip, pkg.size, pkg.algorithm, pkg.checksum,
          (bytes) => this.progress(`Downloading ${pkg.id}: ${Math.floor(bytes / pkg.size * 100)}%`));
        this.progress(`Extracting ${pkg.id}…`);
        await fs.mkdir(unpack);
        if (process.platform === 'darwin') await execute('/usr/bin/ditto', ['-x', '-k', zip, unpack], { timeout: 600000 });
        else {
          const quote = (s: string) => "'" + s.replace(/'/g, "''") + "'";
          const script = `$ErrorActionPreference='Stop'; Expand-Archive -LiteralPath ${quote(zip)} -DestinationPath ${quote(unpack)}`;
          await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { timeout: 600000, windowsHide: true });
        }
        const folders = await fs.readdir(unpack);
        if (folders.length !== 1) throw new Error(`Unexpected archive layout for ${pkg.id}.`);
        const source = path.join(unpack, folders[0]);
        const destination = pkg.id.startsWith('system-images;') ? this.imageDir(sdkStage) : path.join(sdkStage, pkg.id);
        await fs.mkdir(path.dirname(destination), { recursive: true }); await fs.rename(source, destination);
        await fs.rm(zip);
      }
      this.progress('Creating the PigPort Android device…');
      await this.stopRunning();
      const oldSdk = path.join(stage, 'old-sdk');
      const hadSdk = existsSync(this.sdk);
      if (hadSdk) { await fs.rename(this.sdk, oldSdk); backupSdk = oldSdk; }
      try { await fs.rename(sdkStage, this.sdk); switched = true; }
      catch (error) { if (hadSdk) await fs.rename(oldSdk, this.sdk); throw error; }
      await fs.mkdir(this.avdHome, { recursive: true });
      const avd = path.join(this.avdHome, MANAGED_AVD + '.avd');
      // Userdata from a different system image does not boot, so start the device fresh.
      const previous = await fs.readFile(path.join(this.root, 'installed.json'), 'utf8').then((t) => JSON.parse(t).imageId, () => undefined);
      if (previous && previous !== this.imageId) await fs.rm(avd, { recursive: true, force: true });
      await fs.mkdir(avd, { recursive: true });
      const image = this.imageDir(this.sdk) + path.sep;
      const config = [
        'avd.ini.encoding=UTF-8', `AvdId=${MANAGED_AVD}`, 'avd.ini.displayname=PlayBridge Android',
        `abi.type=${this.abi}`, `hw.cpu.arch=${this.abi === 'arm64-v8a' ? 'arm64' : 'x86_64'}`, 'hw.cpu.ncore=4',
        'hw.ramSize=3072', 'hw.gpu.enabled=yes', 'hw.gpu.mode=auto', 'hw.lcd.width=1280', 'hw.lcd.height=720', 'hw.lcd.density=240',
        'hw.keyboard=yes', 'hw.mainKeys=no', 'hw.audioInput=no', 'hw.camera.back=none', 'hw.camera.front=none',
        'disk.dataPartition.size=6G', `image.sysdir.1=${image}`, `tag.id=${this.tag}`, `tag.display=${this.tag === 'default' ? 'Default' : 'Google APIs'}`, 'target=android-35', 'PlayStore.enabled=false',
      ].join('\n') + '\n';
      await fs.writeFile(path.join(avd, 'config.ini'), config);
      await fs.writeFile(path.join(this.avdHome, MANAGED_AVD + '.ini'), `avd.ini.encoding=UTF-8\npath=${avd}\ntarget=android-35\n`);
      await fs.writeFile(path.join(this.root, 'installed.json'), JSON.stringify({ imageId: this.imageId, packages: plan.public.packages, licenses: plan.public.licenses, acceptedAt: new Date().toISOString() }));
      if (!await this.ready()) throw new Error('Android runtime validation failed. Retry setup.');
      switched = false; backupSdk = undefined;
      this.progress('Android runtime is ready.');
    } catch (error) {
      if (switched) {
        await fs.rm(this.sdk, { recursive: true, force: true });
        if (backupSdk) await fs.rename(backupSdk, this.sdk);
      }
      throw error;
    } finally {
      this.working = false;
      if (stage) await fs.rm(stage, { recursive: true, force: true });
    }
  }
  /** On Windows a running emulator or adb server locks the files that setup replaces. */
  private async stopRunning(): Promise<void> {
    if (!existsSync(this.adbPath)) return;
    const adb = (args: string[]) => execute(this.adbPath, args, { timeout: 15000, windowsHide: true }).then((r) => r.stdout, () => '');
    const serials = (await adb(['devices'])).split(/\r?\n/).map((l) => l.split(/\s+/)[0]).filter((s) => s.startsWith('emulator-'));
    let stopped = false;
    for (const serial of serials) {
      if ((await adb(['-s', serial, 'emu', 'avd', 'name'])).split(/\r?\n/)[0].trim() !== MANAGED_AVD) continue;
      await adb(['-s', serial, 'emu', 'kill']); stopped = true;
    }
    await adb(['kill-server']);
    if (stopped) await new Promise((resolve) => setTimeout(resolve, 5000));
  }
}
