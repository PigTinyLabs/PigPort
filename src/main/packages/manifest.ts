/** Extract package/version from Android's binary XML string pool and manifest tag. */
export function androidMetadata(data: Buffer): { bundleId?: string; version?: string } {
  if (data.length < 8 || data.readUInt16LE(0) !== 3) return {};
  const strings: string[] = [];
  let result: { bundleId?: string; version?: string } = {};
  const limit = Math.min(data.length, data.readUInt32LE(4));
  for (let offset = data.readUInt16LE(2); offset + 8 <= limit;) {
    const type = data.readUInt16LE(offset), header = data.readUInt16LE(offset + 2), size = data.readUInt32LE(offset + 4);
    if (header < 8 || size < header || offset + size > limit) throw new Error('Malformed Android manifest chunk');
    const chunk = data.subarray(offset, offset + size);
    if (type === 1 && header >= 28) {
      const count = chunk.readUInt32LE(8), flags = chunk.readUInt32LE(16), start = chunk.readUInt32LE(20);
      if (count > 100000 || header + count * 4 > size) throw new Error('Invalid Android string pool');
      for (let i = 0; i < count; i++) {
        let pos = start + chunk.readUInt32LE(header + i * 4);
        const length = (wide: boolean): number => {
          let n = wide ? chunk.readUInt16LE(pos) : chunk.readUInt8(pos); pos += wide ? 2 : 1;
          const mask = wide ? 0x8000 : 0x80;
          if (n & mask) { const next = wide ? chunk.readUInt16LE(pos) : chunk.readUInt8(pos); pos += wide ? 2 : 1; n = (n & (mask - 1)) * (wide ? 65536 : 256) + next; }
          return n;
        };
        const utf8 = !!(flags & 0x100);
        let bytes = length(!utf8);
        if (utf8) bytes = length(false); else bytes *= 2;
        if (pos + bytes > size) throw new Error('Invalid Android string length');
        strings.push(chunk.toString(utf8 ? 'utf8' : 'utf16le', pos, pos + bytes));
      }
    } else if (type === 0x102 && header >= 16 && size >= 36 && strings[chunk.readUInt32LE(20)] === 'manifest') {
      const start = 16 + chunk.readUInt16LE(24), stride = chunk.readUInt16LE(26), count = chunk.readUInt16LE(28);
      if (stride < 20 || start + stride * count > size) throw new Error('Invalid Android attributes');
      for (let i = 0; i < count; i++) {
        const pos = start + i * stride, name = strings[chunk.readUInt32LE(pos + 4)];
        const raw = chunk.readUInt32LE(pos + 8), value = raw !== 0xffffffff ? strings[raw]
          : chunk[pos + 15] === 3 ? strings[chunk.readUInt32LE(pos + 16)] : undefined;
        if (name === 'package' && value && /^[A-Za-z][\w]*(?:\.[A-Za-z][\w]*)+$/.test(value)) result.bundleId = value;
        if (name === 'versionName') result.version = value;
      }
      return result;
    }
    offset += size;
  }
  return result;
}
