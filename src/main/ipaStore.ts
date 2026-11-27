import { execFile } from 'node:child_process';
import { constants, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const commandTimeout = 40_000;
const downloadTimeout = 60 * 60_000;

type StoreApp = { id: number; name: string; bundleId: string; version?: string };
type JsonRecord = Record<string, unknown>;
type CommandFailure = Error & { stdout?: string; killed?: boolean };

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function records(stdout: string): JsonRecord[] {
  return stdout.split('\n').flatMap((line) => {
    try {
      const value: unknown = JSON.parse(line);
      return isRecord(value) ? [value] : [];
    } catch { return []; }
  });
}

function commandError(error: CommandFailure, detail: string): Error {
  if (error.killed) return new Error('App Store phản hồi quá lâu. Hãy thử lại.');
  if (/keychain passphrase|user interaction is not allowed|keychain is locked|authorization denied/i.test(detail)) {
    return new Error('IPATool chưa truy cập được Chuỗi khóa. Hãy mở khóa Chuỗi khóa đăng nhập rồi thử lại.');
  }
  if (/failed to get account|password token.*expired|auth code.*required/i.test(detail)) {
    return new Error('Hãy đăng nhập Apple trong Terminal rồi thử lại.');
  }
  if (/license is required/i.test(detail)) {
    return new Error('Tài khoản Apple chưa có quyền tải ứng dụng này. Hãy thêm ứng dụng vào thư viện App Store rồi thử lại.');
  }
  if (/app not found|not available|not.*supported/i.test(detail)) {
    return new Error('Ứng dụng này hiện không có trong App Store của tài khoản Apple.');
  }
  return new Error('IPATool chưa hoàn tất yêu cầu. Kiểm tra kết nối hoặc đăng nhập lại rồi thử lại.');
}

function shellQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

function invalidDestination(): Error {
  return new Error('Hãy chọn vị trí lưu tệp có đuôi .ipa.');
}

function outputExists(): Error {
  return new Error('Tệp này đã tồn tại. Hãy chọn tên khác để giữ tệp đang có.');
}

export class IpaStore {
  constructor(private readonly executable = path.join(path.dirname(process.execPath), 'pigport-ipa-ipatool')) {}

  private async tool(): Promise<string> {
    if (!await fs.access(this.executable, constants.X_OK).then(() => true, () => false)) {
      throw new Error('Không tìm thấy IPATool đi kèm. Hãy mở bản PigPort IPA đã đóng gói.');
    }
    return this.executable;
  }

  private async run(args: string[], timeout = commandTimeout): Promise<JsonRecord[]> {
    const executable = await this.tool();
    // Use the same standard IPATool state directory in the launcher and in Terminal.
    const env = { ...process.env };
    delete env.XDG_STATE_HOME;
    delete env.XDG_DATA_HOME;
    try {
      const { stdout } = await execute(executable, ['--non-interactive', '--format', 'json', ...args], {
        env, encoding: 'utf8', timeout, maxBuffer: 256 * 1024,
      });
      return records(stdout);
    } catch (error) {
      const failure = error as CommandFailure;
      const detail = records(failure.stdout ?? '').map((value) => value.error).filter((value) => typeof value === 'string').join('\n');
      if (args[0] === 'auth' && args[1] === 'info' &&
          /failed to get account:.*(?:not found|could not be found|no such file)/i.test(detail)) return [];
      throw commandError(failure, detail);
    }
  }

  async status(): Promise<{ signedIn: boolean }> {
    const result = await this.run(['auth', 'info']);
    return { signedIn: result.some(({ success }) => success === true) };
  }

  async authenticate(): Promise<void> {
    const executable = await this.tool();
    const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'pigport-ipa-auth-'));
    const script = path.join(folder, 'Đăng nhập Apple.command');
    try {
      await fs.writeFile(script, [
        '#!/bin/sh',
        'unset XDG_STATE_HOME XDG_DATA_HOME',
        'trap \'/bin/rm -f "$0"; /bin/rmdir "$(/usr/bin/dirname "$0")"\' EXIT',
        shellQuote(executable) + ' auth login',
        'status=$?',
        'printf "\\nQuay lại PigPort IPA và kiểm tra đăng nhập.\\n"',
        'exit "$status"',
        '',
      ].join('\n'), { mode: 0o700, flag: 'wx' });
      await execute('/usr/bin/open', ['-b', 'com.apple.Terminal', script], { timeout: 15_000 });
    } catch {
      await fs.rm(folder, { recursive: true, force: true }).catch(() => undefined);
      throw new Error('Không mở được Terminal để đăng nhập Apple.');
    }
  }

  async search(value: unknown): Promise<StoreApp[]> {
    if (typeof value !== 'string') throw new Error('Hãy nhập tên game hoặc ứng dụng.');
    const query = value.trim();
    if (!query || query.length > 120 || /[\x00-\x1f\x7f]/.test(query)) {
      throw new Error('Hãy nhập tên game hoặc ứng dụng từ 1 đến 120 ký tự.');
    }
    const result = await this.run(['search', '--platform', 'iphone', '--limit', '15', '--', query]);
    const apps = result.find(({ apps }) => Array.isArray(apps))?.apps;
    if (!Array.isArray(apps)) throw new Error('Không đọc được kết quả tìm kiếm từ App Store.');
    return apps.flatMap((app: unknown): StoreApp[] => {
      if (!isRecord(app) || typeof app.id !== 'number' || !Number.isSafeInteger(app.id) || app.id <= 0 ||
          typeof app.name !== 'string' || !app.name || typeof app.bundleID !== 'string' || !app.bundleID) return [];
      return [{ id: app.id, name: app.name, bundleId: app.bundleID,
        version: typeof app.version === 'string' && app.version ? app.version : undefined }];
    });
  }

  async download(appId: unknown, destination: unknown): Promise<string> {
    if (typeof appId !== 'number' || !Number.isSafeInteger(appId) || appId <= 0) {
      throw new Error('Mã ứng dụng App Store không hợp lệ.');
    }
    if (typeof destination !== 'string' || !path.isAbsolute(destination) ||
        /[\x00-\x1f\x7f]/.test(destination) || path.extname(destination).toLowerCase() !== '.ipa') throw invalidDestination();
    const output = path.normalize(destination);
    try {
      await fs.lstat(output);
      throw outputExists();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const folder = await fs.mkdtemp(path.join(path.dirname(output), '.pigport-ipa-download-')).catch(() => {
      throw new Error('Không tạo được tệp tải trong thư mục đã chọn. Hãy chọn thư mục khác.');
    });
    const staged = path.join(folder, 'Download.ipa');
    try {
      const result = await this.run(['download', '--platform', 'iphone', '--app-id', String(appId), '--output', staged], downloadTimeout);
      const file = await fs.lstat(staged).catch(() => undefined);
      if (!result.some(({ success }) => success === true) || !file?.isFile() || file.size === 0) {
        throw new Error('IPATool chưa tạo được tệp IPA đã tải.');
      }
      // IPATool retains App Store account metadata in the archive.
      await fs.chmod(staged, 0o600).catch((error: NodeJS.ErrnoException) => {
        // A user-selected FAT volume may not support per-file permissions.
        if (error.code !== 'ENOTSUP' && error.code !== 'EOPNOTSUPP') throw error;
      });
      try {
        await fs.link(staged, output);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code ?? '';
        if (code === 'EEXIST') throw outputExists();
        // Filesystems such as exFAT may require an exclusive copy instead of a hard link.
        if (!['ENOTSUP', 'EOPNOTSUPP', 'EACCES', 'EPERM', 'EXDEV', 'EMLINK'].includes(code)) {
          throw new Error('Không lưu được tệp IPA trong thư mục đã chọn.');
        }
        await fs.copyFile(staged, output, constants.COPYFILE_EXCL).catch((copyError: NodeJS.ErrnoException) => {
          if (copyError.code === 'EEXIST') throw outputExists();
          throw new Error('Không lưu được tệp IPA trong thư mục đã chọn.');
        });
      }
      return output;
    } finally {
      await fs.rm(folder, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
