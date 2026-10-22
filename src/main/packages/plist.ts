/** Only metadata scalars are exposed; binary object references are bounded and depth limited. */
export function plistMetadata(bytes: Buffer): Record<string, unknown> {
  if (bytes.subarray(0, 8).toString() !== 'bplist00') {
    const xml = bytes.toString('utf8');
    if (!xml.includes('<plist')) throw new Error('Invalid Info.plist');
    const result: Record<string, unknown> = Object.create(null);
    const decode = (s: string) => s.replace(/&(?:amp|lt|gt|quot|apos);/g, (x) => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" })[x]!);
    for (const key of ['CFBundleExecutable', 'CFBundleIdentifier', 'CFBundleDisplayName', 'CFBundleName', 'CFBundleShortVersionString', 'MinimumOSVersion']) {
      const match = xml.match(new RegExp(`<key>\\s*${key}\\s*</key>\\s*<string>([^<]*)</string>`));
      if (match) result[key] = decode(match[1]);
    }
    return result;
  }
  if (bytes.length < 40) throw new Error('Truncated binary plist');
  const trailer = bytes.length - 32;
  const offsetSize = bytes[trailer + 6], refSize = bytes[trailer + 7];
  const number = (at: number, length: number): number => {
    if (length < 1 || length > 8 || at < 0 || at + length > bytes.length) throw new Error('Invalid plist integer');
    let value = 0;
    for (let i = 0; i < length; i++) value = value * 256 + bytes[at + i];
    if (!Number.isSafeInteger(value)) throw new Error('Plist integer too large');
    return value;
  };
  const count = number(trailer + 8, 8), root = number(trailer + 16, 8), table = number(trailer + 24, 8);
  if (!count || count > 100000 || offsetSize < 1 || offsetSize > 8 || refSize < 1 || refSize > 8 || table < 8 || table + count * offsetSize > trailer) throw new Error('Invalid plist offset table');
  const object = (id: number, depth: number): unknown => {
    if (id >= count || depth > 32) throw new Error('Invalid plist reference');
    let at = number(table + id * offsetSize, offsetSize);
    if (at < 8 || at >= table) throw new Error('Invalid plist object');
    const tag = bytes[at++], type = tag >> 4;
    let length = tag & 15;
    if (length === 15 && [4, 5, 6, 10, 13].includes(type)) {
      const marker = bytes[at++];
      if ((marker >> 4) !== 1) throw new Error('Invalid plist length');
      const width = 2 ** (marker & 15);
      length = number(at, width); at += width;
    }
    const need = (n: number) => { if (at + n > table) throw new Error('Truncated plist object'); };
    if (type === 0) return tag === 9 ? true : tag === 8 ? false : null;
    if (type === 1) { need(2 ** length); return number(at, 2 ** length); }
    if (type === 5 || type === 6) {
      need(length * (type === 6 ? 2 : 1));
      const data = Buffer.from(bytes.subarray(at, at + length * (type === 6 ? 2 : 1)));
      return type === 6 ? data.swap16().toString('utf16le') : data.toString('utf8');
    }
    if (type === 13) {
      need(length * refSize * 2);
      const result: Record<string, unknown> = Object.create(null);
      for (let i = 0; i < length; i++) {
        const key = object(number(at + i * refSize, refSize), depth + 1);
        if (typeof key !== 'string') throw new Error('Invalid plist key');
        // Ignore nested assets and arrays: only top-level metadata is needed.
        if (['CFBundleExecutable', 'CFBundleIdentifier', 'CFBundleDisplayName', 'CFBundleName', 'CFBundleShortVersionString', 'MinimumOSVersion'].includes(key)) result[key] = object(number(at + (length + i) * refSize, refSize), depth + 1);
      }
      return result;
    }
    return undefined;
  };
  const value = object(root, 0);
  if (!value || typeof value !== 'object') throw new Error('Info.plist must be a dictionary');
  return value as Record<string, unknown>;
}
