import { open, rename, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const ARM64 = 0x0100000c;
const align = (n: number) => Math.ceil(n / 8) * 8;

/** Independent Mach-O conversion; no PlayCover source or decryption code. */
export function convertMachHeader(data: Buffer, sliceSize: number,
  mapLibrary: (name: string) => string = (name) => name): Buffer {
  if (data.length < 32 || data.readUInt32LE(0) !== 0xfeedfacf || data.readUInt32LE(4) !== ARM64) throw new Error('Expected a 64-bit ARM executable.');
  if ((data.readUInt32LE(8) & 0xffffff) === 2) throw new Error('arm64e-only binaries are not supported. Use an IPA containing arm64.');
  const ncmds = data.readUInt32LE(16), bytes = data.readUInt32LE(20);
  if (32 + bytes > data.length || ncmds > 10000) throw new Error('Invalid Mach-O command table.');
  const commands: Buffer[] = [];
  let pos = 32, firstData = sliceSize, platformFound = false;
  for (let i = 0; i < ncmds; i++) {
    if (pos + 8 > 32 + bytes) throw new Error('Truncated Mach-O load command.');
    const type = data.readUInt32LE(pos), size = data.readUInt32LE(pos + 4);
    if (size < 8 || size % 8 || pos + size > 32 + bytes) throw new Error('Invalid Mach-O load command.');
    let cmd: Buffer = Buffer.from(data.subarray(pos, pos + size));
    if (type === 0x19) {
      if (size < 72) throw new Error('Invalid Mach-O segment.');
      const fileOffset = Number(cmd.readBigUInt64LE(40)), fileSize = Number(cmd.readBigUInt64LE(48)), sections = cmd.readUInt32LE(64);
      if (!Number.isSafeInteger(fileOffset + fileSize) || fileOffset + fileSize > sliceSize || 72 + sections * 80 > size) throw new Error('Invalid Mach-O sections.');
      if (fileOffset > 0 && fileSize) firstData = Math.min(firstData, fileOffset);
      for (let j = 0; j < sections; j++) {
        const section = 72 + j * 80, offset = cmd.readUInt32LE(section + 48), flags = cmd.readUInt32LE(section + 64) & 0xff;
        if (offset && ![1, 0xc, 0x12].includes(flags)) firstData = Math.min(firstData, offset);
      }
    }
    if (type === 0x21 || type === 0x2c) {
      if (size < 20) throw new Error('Invalid encryption command.');
      if (cmd.readUInt32LE(16) !== 0) throw new Error('This IPA is encrypted (FairPlay). Supply an unencrypted IPA; PigPort does not decrypt apps.');
    }
    if (type === 0x32 || type === 0x25) {
      if (size < (type === 0x32 ? 24 : 16)) throw new Error('Invalid platform command.');
      const platform = type === 0x25 ? 2 : cmd.readUInt32LE(8);
      if (platform !== 2 && platform !== 6) throw new Error(`Unsupported executable platform ${platform}; expected iOS or Mac Catalyst.`);
      const minimum = cmd.readUInt32LE(type === 0x25 ? 8 : 12), sdk = cmd.readUInt32LE(type === 0x25 ? 12 : 16);
      cmd = Buffer.alloc(24); cmd.writeUInt32LE(0x32); cmd.writeUInt32LE(24, 4);
      cmd.writeUInt32LE(6, 8); cmd.writeUInt32LE(Math.max(minimum, 0x000d0100), 12);
      cmd.writeUInt32LE(Math.max(sdk, 0x000d0100), 16);
      platformFound = true;
    }
    if ([0xc, 0x80000018, 0x8000001f, 0x80000023].includes(type)) {
      if (size < 24) throw new Error('Invalid library command.');
      const offset = cmd.readUInt32LE(8), end = cmd.indexOf(0, offset);
      if (offset < 24 || end < offset) throw new Error('Invalid library name.');
      const original = cmd.toString('utf8', offset, end), mapped = mapLibrary(original);
      if (mapped !== original) {
        const replacement = Buffer.alloc(align(24 + Buffer.byteLength(mapped) + 1));
        cmd.copy(replacement, 0, 0, 24); replacement.writeUInt32LE(replacement.length, 4); replacement.writeUInt32LE(24, 8);
        replacement.write(mapped, 24); cmd = replacement;
      }
    }
    commands.push(cmd); pos += size;
  }
  if (pos !== 32 + bytes || !platformFound) throw new Error('Missing or invalid iOS platform information.');
  const table = Buffer.concat(commands), end = 32 + table.length;
  if (firstData === sliceSize || end > firstData || end > data.length) throw new Error('Not enough Mach-O header space for Mac conversion.');
  const result = Buffer.from(data);
  result.fill(0, 32, Math.max(32 + bytes, end)); table.copy(result, 32); result.writeUInt32LE(table.length, 20);
  return result;
}

/** Thin FAT containers to generic arm64, reject encrypted slices, patch load commands in a temporary copy. */
export async function convertMachFile(file: string, required = false): Promise<boolean> {
  const input = await open(file, 'r');
  const temp = file + '.playbridge-patch';
  try {
    const length = (await input.stat()).size;
    const head = Buffer.alloc(Math.min(length, 4096)); await input.read(head, 0, head.length, 0);
    if (head.length < 4) { if (required) throw new Error('The app executable is empty.'); return false; }
    let offset = 0, size = length;
    const magic = head.readUInt32BE(0);
    if (magic === 0xcafebabe || magic === 0xcafebabf) {
      const count = head.readUInt32BE(4), stride = magic === 0xcafebabf ? 32 : 20;
      if (count > 32 || 8 + count * stride > head.length) throw new Error('Invalid universal executable.');
      let found = false;
      for (let i = 0; i < count; i++) {
        const pos = 8 + i * stride;
        if (head.readUInt32BE(pos) !== ARM64 || (head.readUInt32BE(pos + 4) & 0xffffff) === 2) continue;
        offset = stride === 32 ? Number(head.readBigUInt64BE(pos + 8)) : head.readUInt32BE(pos + 8);
        size = stride === 32 ? Number(head.readBigUInt64BE(pos + 16)) : head.readUInt32BE(pos + 12); found = true; break;
      }
      if (!found) throw new Error('This IPA has no supported generic arm64 slice.');
    } else if (head.readUInt32LE(0) !== 0xfeedfacf) {
      if (required) throw new Error('The app executable is not a supported Mach-O binary.'); return false;
    }
    if (!Number.isSafeInteger(offset + size) || size < 32 || offset < 0 || offset + size > length) throw new Error('Invalid binary slice bounds.');
    const header = Buffer.alloc(Math.min(size, 4 * 1024 * 1024));
    const read = await input.read(header, 0, header.length, offset);
    if (read.bytesRead !== header.length) throw new Error('Truncated binary.');
    const patched = convertMachHeader(header, size, (name) =>
      (name.startsWith('/System/Library/') || name.startsWith('/usr/lib/')) && existsSync('/System/iOSSupport' + name)
        ? '/System/iOSSupport' + name : name);
    const output = await open(temp, 'wx', 0o755);
    try {
      await output.writeFile(patched);
      const chunk = Buffer.alloc(4 * 1024 * 1024);
      for (let pos = header.length; pos < size;) {
        const { bytesRead } = await input.read(chunk, 0, Math.min(chunk.length, size - pos), offset + pos);
        if (!bytesRead) throw new Error('Truncated binary.');
        await output.writeFile(chunk.subarray(0, bytesRead)); pos += bytesRead;
      }
    } finally { await output.close(); }
    await rename(temp, file);
    return true;
  } finally { await input.close(); await unlink(temp).catch(() => undefined); }
}
