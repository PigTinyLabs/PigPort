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
export const GOOGLE_PLAY_AVD = 'PigPort_Google_Play_35';
type Profile = typeof MANAGED_AVD | typeof GOOGLE_PLAY_AVD;
const profiles: readonly Profile[] = [MANAGED_AVD, GOOGLE_PLAY_AVD];

export class ManagedAndroid {
  private plan?: { public: RuntimePlan; packages: RuntimePackage[]; profile: Profile };
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
  private tag(profile: Profile): string { return profile === GOOGLE_PLAY_AVD ? 'google_apis_playstore' : this.abi === 'x86_64' ? 'google_apis' : 'default'; }
  private imageId(profile: Profile): string { return `system-images;android-35;${this.tag(profile)};${this.abi}`; }
  private imageDir(profile: Profile): string { return path.join(this.sdk, 'system-images', 'android-35', this.tag(profile), this.abi); }
  private marker(profile: Profile): string { return path.join(this.root, profile === GOOGLE_PLAY_AVD ? 'google-play.json' : 'installed.json'); }
  get adbPath(): string { return path.join(this.sdk, 'platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb'); }
  private get emulatorPath(): string { return path.join(this.sdk, 'emulator', process.platform === 'win32' ? 'emulator.exe' : 'emulator'); }
  async relocateAvd(destination: ManagedAndroid): Promise<void> {
    for (const profile of profiles) {
      const avd = profile + '.avd';
      const ini = path.join(this.avdHome, profile + '.ini');
      if (!existsSync(ini)) continue;
      const configFile = path.join(this.avdHome, avd, 'config.ini');
      const [iniText, config] = await Promise.all([fs.readFile(ini, 'utf8'), fs.readFile(configFile, 'utf8')]);
      await fs.writeFile(ini, iniText.replace(/^path=.*$/m, () => `path=${path.join(destination.avdHome, avd)}`));
      await fs.writeFile(configFile, config.replace(/^image\.sysdir\.1=.*$/m,
        () => `image.sysdir.1=${destination.imageDir(profile)}${path.sep}`));
    }
  }

  async ready(profile: Profile = MANAGED_AVD): Promise<boolean> {
    const marker = await fs.readFile(this.marker(profile), 'utf8').catch(() => '');
    try {
      const saved = JSON.parse(marker);
      return saved.imageId === this.imageId(profile) && existsSync(this.adbPath) && existsSync(this.emulatorPath)
        && existsSync(path.join(this.imageDir(profile), 'system.img')) && existsSync(path.join(this.avdHome, profile + '.ini'))
        && existsSync(path.join(this.avdHome, profile + '.avd', 'config.ini'));
    } catch { return false; }
  }
  async readyAvds(): Promise<Profile[]> {
    const available = await Promise.all(profiles.map((profile) => this.ready(profile)));
    return profiles.filter((_profile, index) => available[index]);
  }
  async prepare(profile: Profile = MANAGED_AVD): Promise<RuntimePlan> {
    if (this.working) throw new Error('Android setup is already in progress.');
    const host = process.platform === 'darwin' ? 'macosx' : process.platform === 'win32' ? 'windows' : undefined;
    if (!host) throw new Error('Managed Android supports macOS and Windows.');
    this.progress('Reading official Android runtime packages…');
    const tools = [!existsSync(this.adbPath) && 'platform-tools', !existsSync(this.emulatorPath) && 'emulator']
      .filter((id): id is string => !!id);
    const tag = this.tag(profile);
    const imageBase = `${BASE}sys-img/${tag === 'default' ? 'android' : tag}/`;
    const [sdkXml, imageXml] = await Promise.all([tools.length ? downloadText(BASE + 'repository2-3.xml') : undefined, downloadText(imageBase + 'sys-img2-3.xml')]);
    const sdkPackages = sdkXml ? repositoryPackages(sdkXml, BASE, host, process.arch) : [];
    const imagePackages = repositoryPackages(imageXml, imageBase, host, process.arch);
    const packages = [...tools.map((id) => latestPackage(sdkPackages, id)), latestPackage(imagePackages, this.imageId(profile))];
    const licenses = [...new Map(packages.map((p) => [p.licenseId, { id: p.licenseId, text: p.licenseText }])).values()];
    const plan: RuntimePlan = { token: randomUUID(), bytes: packages.reduce((n, p) => n + p.size, 0), licenses, packages: packages.map((p) => p.id) };
    this.plan = { public: plan, packages, profile }; return plan;
  }
  async install(token: string, accepted: boolean): Promise<void> {
    if (this.working) throw new Error('Android setup is already in progress.');
    if (!this.plan || this.plan.public.token !== token || accepted !== true) throw new Error('Review and accept the displayed Android terms before installation.');
    const plan = this.plan; this.plan = undefined; this.working = true;
    const { profile } = plan;
    let stage: string | undefined;
    const published: { destination: string; backup?: string }[] = [];
    try {
      await fs.mkdir(this.root, { recursive: true });
      const disk = await fs.statfs(this.root);
      const needed = plan.public.bytes * 3 + 8 * 1024 ** 3;
      if (disk.bavail * disk.bsize < needed) throw new Error(`Android setup needs about ${Math.ceil(needed / 1024 ** 3)} GiB free disk space.`);
      stage = await fs.mkdtemp(path.join(this.root, 'setup-'));
      const archives: { source: string; destination: string }[] = [];
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
        const destination = pkg.id.startsWith('system-images;') ? this.imageDir(profile) : path.join(this.sdk, pkg.id);
        const expected = pkg.id.startsWith('system-images;') ? 'system.img'
          : pkg.id === 'emulator' ? path.basename(this.emulatorPath) : path.basename(this.adbPath);
        if (!existsSync(path.join(source, expected))) throw new Error(`Missing ${expected} in the official ${pkg.id} archive.`);
        archives.push({ source, destination });
        await fs.rm(zip);
      }
      this.progress('Creating the PigPort Android device…');
      if (archives.some(({ destination }) => destination !== this.imageDir(profile) && existsSync(destination))) await this.stopRunning(true);
      else if (existsSync(this.imageDir(profile))) await this.stopRunning(true, profile);
      const avd = path.join(this.avdHome, profile + '.avd');
      const image = this.imageDir(profile) + path.sep;
      const googlePlay = profile === GOOGLE_PLAY_AVD;
      const tag = this.tag(profile);
      const config = [
        'avd.ini.encoding=UTF-8', `AvdId=${profile}`, `avd.ini.displayname=${googlePlay ? 'PigPort Google Play' : 'PlayBridge Android'}`,
        `abi.type=${this.abi}`, `hw.cpu.arch=${this.abi === 'arm64-v8a' ? 'arm64' : 'x86_64'}`, 'hw.cpu.ncore=4',
        'hw.ramSize=3072', 'hw.gpu.enabled=yes', 'hw.gpu.mode=auto', 'hw.lcd.width=1280', 'hw.lcd.height=720', 'hw.lcd.density=240',
        'hw.keyboard=yes', 'hw.mainKeys=no', 'hw.audioInput=no', 'hw.camera.back=none', 'hw.camera.front=none',
        'disk.dataPartition.size=32G', `image.sysdir.1=${image}`, `tag.id=${tag}`,
        `tag.display=${googlePlay ? 'Google Play' : tag === 'default' ? 'Default' : 'Google APIs'}`, 'target=android-35', `PlayStore.enabled=${googlePlay}`,
      ].join('\n') + '\n';
      for (const [destination, content] of [
        [path.join(avd, 'config.ini'), config],
        [path.join(this.avdHome, profile + '.ini'), `avd.ini.encoding=UTF-8\npath=${avd}\ntarget=android-35\n`],
        [this.marker(profile), JSON.stringify({ imageId: this.imageId(profile), packages: plan.public.packages, licenses: plan.public.licenses, acceptedAt: new Date().toISOString() })],
      ]) {
        const source = path.join(stage, randomUUID());
        await fs.writeFile(source, content);
        archives.push({ source, destination });
      }
      for (const { source, destination } of archives) {
        await fs.mkdir(path.dirname(destination), { recursive: true });
        const backup = existsSync(destination) ? path.join(stage, randomUUID()) : undefined;
        if (backup) await fs.rename(destination, backup);
        published.push({ destination, backup });
        await fs.rename(source, destination);
      }
      if (!await this.ready(profile)) throw new Error('Android runtime validation failed. Retry setup.');
      this.progress('Android runtime is ready.');
    } catch (error) {
      try {
        for (const { destination, backup } of published.reverse()) {
          await fs.rm(destination, { recursive: true, force: true });
          if (backup) await fs.rename(backup, destination);
        }
      } catch (rollbackError) {
        const recovery = stage;
        stage = undefined;
        throw new Error(`Restore Android setup files from ${recovery}: ${(rollbackError as Error).message}`, { cause: error });
      }
      throw error;
    } finally {
      this.working = false;
      if (stage) await fs.rm(stage, { recursive: true, force: true });
    }
  }
  /** On Windows a running emulator or adb server locks the files that setup replaces. */
  async stopRunning(verify = false, profile?: Profile): Promise<void> {
    if (!existsSync(this.adbPath)) return;
    const adb = (args: string[]) => execute(this.adbPath, args, { timeout: 15000, windowsHide: true }).then((r) => r.stdout, (error) => {
      if (verify) throw error;
      return '';
    });
    const emulators = async () => (await adb(['devices'])).split(/\r?\n/).map((l) => l.split(/\s+/)[0]).filter((s) => s.startsWith('emulator-'));
    const matches = (name: string) => profile ? name === profile : isManagedProfile(name);
    let stopped = false;
    for (const serial of await emulators()) {
      if (!matches((await adb(['-s', serial, 'emu', 'avd', 'name'])).split(/\r?\n/)[0].trim())) continue;
      await adb(['-s', serial, 'emu', 'kill']); stopped = true;
    }
    if (stopped) await new Promise((resolve) => setTimeout(resolve, 5000));
    if (stopped && verify) {
      for (const serial of await emulators()) {
        if (matches((await adb(['-s', serial, 'emu', 'avd', 'name'])).split(/\r?\n/)[0].trim())) {
          throw new Error('Built-in Android did not stop. Close it before moving game storage.');
        }
      }
    }
    if (!profile) await adb(['kill-server']);
  }
}

export function isManagedProfile(name: string): name is Profile {
  return name === MANAGED_AVD || name === GOOGLE_PLAY_AVD;
}
