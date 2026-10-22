import { open } from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';

export interface ArchiveEntry { offset: number; compressed: number; size: number; method: number; flags: number; mode: number }

/** Reads only the ZIP directory and selected metadata, never extracts application code. */
export async function inspectArchive<T>(file: string, inspect: (names: string[], read: (name: string) => Promise<Buffer>, entries: ReadonlyMap<string, ArchiveEntry>) => Promise<T>): Promise<T> {
  const handle = await open(file, 'r');
  try {
    const size = (await handle.stat()).size;
    const readAt = async (offset: number, length: number): Promise<Buffer> => {
      if (offset < 0 || length < 0 || offset + length > size) throw new Error('Truncated package');
      const buf = Buffer.alloc(length);
      let total = 0;
      while (total < length) {
        const { bytesRead } = await handle.read(buf, total, length - total, offset + total);
        if (!bytesRead) throw new Error('Truncated package');
        total += bytesRead;
      }
      return buf;
    };
    const tail = await readAt(Math.max(0, size - 65557), Math.min(size, 65557));
    let end = tail.length - 22;
    while (end >= 0 && !(tail.readUInt32LE(end) === 0x06054b50 && end + 22 + tail.readUInt16LE(end + 20) === tail.length)) end--;
    if (end < 0) throw new Error('Not a valid ZIP package');
    const count = tail.readUInt16LE(end + 10);
    const length = tail.readUInt32LE(end + 12);
    const offset = tail.readUInt32LE(end + 16);
    if (count === 65535 || length === 0xffffffff || offset === 0xffffffff) throw new Error('ZIP64 packages are not supported yet');
    if (tail.readUInt32LE(end + 4) !== 0 || tail.readUInt16LE(end + 8) !== count) throw new Error('Multi-volume packages are not supported');
    if (length > 32 * 1024 * 1024) throw new Error('Package directory is too large');
    const directory = await readAt(offset, length);
    const entries = new Map<string, ArchiveEntry>();
    let pos = 0;
    for (let i = 0; i < count; i++) {
      if (pos + 46 > directory.length || directory.readUInt32LE(pos) !== 0x02014b50) throw new Error('Invalid package directory');
      const nameLength = directory.readUInt16LE(pos + 28);
      const next = pos + 46 + nameLength + directory.readUInt16LE(pos + 30) + directory.readUInt16LE(pos + 32);
      if (next > directory.length) throw new Error('Truncated package directory');
      const name = directory.toString('utf8', pos + 46, pos + 46 + nameLength);
      if (entries.has(name)) throw new Error('Duplicate package entry');
      entries.set(name, { mode: directory.readUInt32LE(pos + 38) >>> 16, offset: directory.readUInt32LE(pos + 42), compressed: directory.readUInt32LE(pos + 20), size: directory.readUInt32LE(pos + 24), method: directory.readUInt16LE(pos + 10), flags: directory.readUInt16LE(pos + 8) });
      pos = next;
    }
    return await inspect([...entries.keys()], async (name) => {
      const e = entries.get(name);
      if (!e) throw new Error(`Missing ${name}`);
      if (e.flags & 1) throw new Error('Encrypted ZIP entries are not supported');
      if (e.size > 8 * 1024 * 1024 || e.compressed > 8 * 1024 * 1024) throw new Error('Package metadata exceeds 8 MiB');
      const local = await readAt(e.offset, 30);
      if (local.readUInt32LE(0) !== 0x04034b50) throw new Error('Invalid ZIP entry');
      const bytes = await readAt(e.offset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28), e.compressed);
      const result = e.method === 0 ? bytes : e.method === 8 ? inflateRawSync(bytes, { maxOutputLength: 8 * 1024 * 1024 }) : undefined;
      if (!result || result.length !== e.size) throw new Error('Invalid or unsupported package compression');
      return result;
    }, entries);
  } finally { await handle.close(); }
}

/** Verify both ZIP directories before delegating extraction to the OS. */
export async function validateLocalEntries(file: string, entries: ReadonlyMap<string, ArchiveEntry>): Promise<void> {
  const handle = await open(file, 'r');
  try {
    const size = (await handle.stat()).size;
    for (const [name, entry] of entries) {
      const header = Buffer.alloc(30);
      if (entry.offset + 30 > size || (await handle.read(header, 0, 30, entry.offset)).bytesRead !== 30 || header.readUInt32LE(0) !== 0x04034b50) throw new Error('Invalid local ZIP header.');
      const nameLength = header.readUInt16LE(26), extra = header.readUInt16LE(28);
      const bytes = Buffer.alloc(nameLength);
      if ((await handle.read(bytes, 0, nameLength, entry.offset + 30)).bytesRead !== nameLength || bytes.toString('utf8') !== name) throw new Error('Conflicting local ZIP path.');
      if (entry.offset + 30 + nameLength + extra + entry.compressed > size || header.readUInt16LE(8) !== entry.method || header.readUInt16LE(6) !== entry.flags || (entry.flags & 1) || ![0, 8].includes(entry.method)) throw new Error('Invalid local ZIP entry.');
    }
  } finally { await handle.close(); }
}
