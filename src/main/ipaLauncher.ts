import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { emit, receive, register } from './desktop';
import { IpaStore } from './ipaStore';
import { inspectArchive } from './packages/archive';
import { plistMetadata } from './packages/plist';
import { NativeIpaRuntime, validateIpaEntries } from './runtime/ipa';
import { convertMachHeader } from './runtime/macho';

const execute = promisify(execFile);
const ARM64 = 0x0100000c;
const ARM64E = 2;
const FAT = 0xcafebabe;
const FAT64 = 0xcafebabf;
const MACH64 = 0xfeedfacf;
const MACH32 = 0xfeedface;
const HEADER_LIMIT = 4 * 1024 * 1024;

type InstalledApp = { appId: string; name: string; version?: string };
type Inspection = InstalledApp & {
  file: string;
  size: number;
  architectures: string[];
  compatibility: 'ready' | 'encrypted' | 'unsupported';
  reason?: string;
};
type ReadBinary = (offset: number, length: number) => Promise<Buffer>;

function validId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9.-]+$/.test(value) && !value.includes('..');
}

function appMetadata(plist: Record<string, unknown>, appId: string, fallback: string): InstalledApp {
  const value = (key: string) => typeof plist[key] === 'string' ? plist[key].trim() || undefined : undefined;
  return {
    appId,
    name: value('CFBundleDisplayName') ?? value('CFBundleName') ?? fallback,
    version: value('CFBundleShortVersionString'),
  };
}

function architecture(cpu: number, subtype: number): string {
  if (cpu === ARM64) return (subtype & 0xffffff) === ARM64E ? 'arm64e' : 'arm64';
  if (cpu === 12) return 'arm32';
  if (cpu === 0x01000007) return 'x86_64';
  if (cpu === 7) return 'x86';
  return 'không rõ';
}

async function inspectBinary(size: number, read: ReadBinary): Promise<Pick<Inspection, 'architectures' | 'compatibility' | 'reason'>> {
  const architectures = new Set<string>();
  try {
    if (size < 32) throw new Error('Tệp thực thi bị thiếu hoặc không đầy đủ.');
    const head = await read(0, 32);
    const magic = head.readUInt32BE(0);
    let slice: { offset: number; size: number } | undefined;
    if (magic === FAT || magic === FAT64) {
      const count = head.readUInt32BE(4), stride = magic === FAT64 ? 32 : 20;
      if (!count || count > 32 || 8 + count * stride > size) throw new Error('Bảng kiến trúc Mach-O không hợp lệ.');
      const table = await read(8, count * stride);
      for (let index = 0; index < count; index++) {
        const pos = index * stride;
        const arch = architecture(table.readUInt32BE(pos), table.readUInt32BE(pos + 4));
        architectures.add(arch);
        if (arch === 'arm64' && !slice) {
          const offset = magic === FAT64 ? Number(table.readBigUInt64BE(pos + 8)) : table.readUInt32BE(pos + 8);
          const length = magic === FAT64 ? Number(table.readBigUInt64BE(pos + 16)) : table.readUInt32BE(pos + 12);
          if (offset < 8 + count * stride || length < 32 || !Number.isSafeInteger(offset + length) || offset + length > size) {
            throw new Error('Vùng mã ARM64 nằm ngoài tệp thực thi.');
          }
          slice = { offset, size: length };
        }
      }
    } else if ([MACH64, MACH32].includes(head.readUInt32LE(0))) {
      const arch = architecture(head.readUInt32LE(4), head.readUInt32LE(8));
      architectures.add(arch);
      if (arch === 'arm64' && head.readUInt32LE(0) === MACH64) slice = { offset: 0, size };
    } else throw new Error('Tệp thực thi không phải định dạng Mach-O được hỗ trợ.');
    if (!slice) throw new Error('IPA cần chứa mã arm64 tiêu chuẩn cho Mac Apple Silicon.');

    const prefix = slice.offset === 0 ? head : await read(slice.offset, 32);
    const commandBytes = prefix.readUInt32LE(20);
    if (commandBytes + 32 > Math.min(HEADER_LIMIT, slice.size)) throw new Error('Bảng lệnh Mach-O vượt giới hạn hỗ trợ.');
    // A legacy minimum-version command can grow by eight bytes when converted.
    const sizeToRead = Math.min(32 + commandBytes + 8, HEADER_LIMIT, slice.size);
    const header = await read(slice.offset, sizeToRead);
    convertMachHeader(header, slice.size);
    return { architectures: [...architectures], compatibility: 'ready' };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (/encrypted \(FairPlay\)/i.test(reason)) {
      return { architectures: [...architectures], compatibility: 'encrypted',
        reason: 'Tệp thực thi được bảo vệ bằng FairPlay. Hãy chọn IPA arm64 đã ở dạng không mã hóa.' };
    }
    return { architectures: [...architectures], compatibility: 'unsupported', reason };
  }
}

async function inspectIpa(input: unknown): Promise<Inspection> {
  if (typeof input !== 'string' || !path.isAbsolute(input) || path.extname(input).toLowerCase() !== '.ipa') {
    throw new Error('Chọn tệp IPA trên máy Mac.');
  }
  const stat = await fs.stat(input);
  if (!stat.isFile()) throw new Error('Hãy chọn một tệp IPA.');
  return inspectArchive(input, async (names, read, entries, readRange) => {
    validateIpaEntries(entries);
    const plists = names.filter((name) => /^Payload\/[^/]+\.app\/Info\.plist$/.test(name));
    if (plists.length !== 1) throw new Error('IPA phải chứa đúng một ứng dụng trong thư mục Payload.');
    const plist = plistMetadata(await read(plists[0]));
    const appId = plist.CFBundleIdentifier;
    const executable = plist.CFBundleExecutable;
    if (!validId(appId)) throw new Error('Định danh ứng dụng trong IPA không hợp lệ.');
    if (typeof executable !== 'string' || !executable || executable !== path.basename(executable) ||
        /[\\/:\x00-\x1f]/.test(executable) || executable === '.' || executable === '..') {
      throw new Error('Tên tệp thực thi trong IPA không hợp lệ.');
    }
    const name = path.posix.join(path.posix.dirname(plists[0]), executable);
    const entry = entries.get(name);
    const binary = entry ? await inspectBinary(entry.size, (offset, length) => readRange(name, offset, length)) : {
      architectures: [], compatibility: 'unsupported' as const, reason: 'Không tìm thấy tệp thực thi chính trong IPA.',
    };
    return { ...appMetadata(plist, appId, path.basename(input, path.extname(input))), file: input, size: stat.size, ...binary };
  });
}

const data = process.env.PIGPORT_USER_DATA;
if (!data || !path.isAbsolute(data)) throw new Error('PIGPORT_USER_DATA must be an absolute path.');
const runtimeRoot = path.join(data, 'ios');
const applications = path.join(runtimeRoot, 'Applications');
const progress = (message: string) => emit('ipa:progress', message);
const runtime = new NativeIpaRuntime(runtimeRoot, progress, {
  cacheName: 'io.playbridge.ipa-launcher', patchAntiCheat: false, inheritDeviceType: false, confirmLaunch: true,
});
const appStore = new IpaStore();
let active: Promise<unknown> | undefined;

async function installedApp(appId: string): Promise<InstalledApp | undefined> {
  if (!validId(appId)) return undefined;
  const bundle = path.join(applications, appId + '.app');
  const infoPath = path.join(bundle, 'Info.plist');
  const sealPath = path.join(bundle, '_CodeSignature', 'CodeResources');
  try {
    if (!(await fs.lstat(bundle)).isDirectory() || !(await fs.lstat(sealPath)).isFile()) return undefined;
    const info = await fs.lstat(infoPath);
    if (!info.isFile() || info.size > 8 * 1024 * 1024) return undefined;
    const plist = plistMetadata(await fs.readFile(infoPath));
    return plist.CFBundleIdentifier === appId ? appMetadata(plist, appId, appId) : undefined;
  } catch { return undefined; }
}

async function exclusive<T>(task: () => Promise<T>): Promise<T> {
  if (active) throw new Error('Đợi thao tác IPA hiện tại hoàn tất.');
  const pending = Promise.resolve().then(task);
  active = pending;
  try { return await pending; }
  finally { active = undefined; progress(''); }
}

register('ipa:list', async () => {
  await active?.catch(() => undefined);
  const files = await fs.readdir(applications, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  // The installed bundles keep their own metadata, so recovery after a restart does not depend on an index.
  const rows = await Promise.all(files.filter((file) => file.isDirectory() && file.name.endsWith('.app'))
    .map(({ name }) => installedApp(name.slice(0, -4))));
  return rows.filter((row): row is InstalledApp => row !== undefined).sort((a, b) => a.name.localeCompare(b.name, 'vi'));
});
register('ipa:inspect', (file: unknown) => inspectIpa(file));
register('ipa:install', (file: unknown) => exclusive(async () => {
  const ipa = await inspectIpa(file);
  if (ipa.compatibility !== 'ready') throw new Error(ipa.reason ?? 'IPA chưa thể cài đặt.');
  await runtime.install(ipa.file, ipa.appId);
  const row = await installedApp(ipa.appId);
  if (!row) throw new Error('Không đọc được thông tin ứng dụng sau khi cài.');
  return row;
}));
async function requireInstalled(input: unknown): Promise<string> {
  if (!validId(input) || !await installedApp(input)) throw new Error('Ứng dụng chưa có trong thư viện.');
  return input;
}
register('ipa:launch', (appId: unknown) => exclusive(async () => {
  await runtime.launch(await requireInstalled(appId));
}));
register('ipa:reveal', (appId: unknown) => exclusive(async () => {
  await execute('/usr/bin/open', ['-R', path.join(applications, await requireInstalled(appId) + '.app')], { timeout: 15000 });
}));
register('ipa:storeStatus', () => exclusive(() => appStore.status()));
register('ipa:storeAuth', () => exclusive(() => appStore.authenticate()));
register('ipa:storeSearch', (query: unknown) => exclusive(() => appStore.search(query)));
register('ipa:storeDownload', (appId: unknown, output: unknown) => exclusive(async () => {
  progress('Đang tải từ App Store…');
  return appStore.download(appId, output);
}));
receive(async () => {});
