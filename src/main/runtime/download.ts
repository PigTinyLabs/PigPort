import https from 'node:https';
import { createHash } from 'node:crypto';
import { createWriteStream, promises as fs } from 'node:fs';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { IncomingMessage } from 'node:http';

export function officialUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.hostname !== 'dl.google.com' || url.username || url.password || (url.port && url.port !== '443')) throw new Error('Runtime downloads must use the official Google HTTPS repository.');
  return url;
}
function response(value: string, redirects = 0): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const url = officialUrl(value);
    const request = https.get(url, { headers: { 'User-Agent': 'PigPort/0.2' } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode ?? 0)) {
        res.resume();
        if (redirects >= 4 || !res.headers.location) return reject(new Error('Too many runtime download redirects.'));
        response(new URL(res.headers.location, url).href, redirects + 1).then(resolve, reject); return;
      }
      if (res.statusCode !== 200) { res.resume(); reject(new Error(`Runtime repository returned HTTP ${res.statusCode}.`)); return; }
      resolve(res);
    });
    request.setTimeout(60000, () => request.destroy(new Error('Runtime download timed out.')));
    request.on('error', reject);
  });
}
export async function downloadText(url: string): Promise<string> {
  const stream = await response(url), chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.from(chunk); size += bytes.length;
    if (size > 32 * 1024 * 1024) { stream.destroy(); throw new Error('Runtime repository metadata is too large.'); }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString('utf8');
}
export async function downloadVerified(url: string, target: string, size: number, algorithm: string, checksum: string, progress: (bytes: number) => void): Promise<void> {
  if (!['sha1', 'sha256'].includes(algorithm) || !new RegExp(`^[a-f0-9]{${algorithm === 'sha1' ? 40 : 64}}$`, 'i').test(checksum)) throw new Error('Invalid official package checksum.');
  if (!Number.isSafeInteger(size) || size <= 0 || size > 12 * 1024 ** 3) throw new Error('Invalid official package size.');
  const temp = target + '.download'; let received = 0, last = 0;
  const hash = createHash(algorithm);
  try {
    const input = await response(url);
    const meter = new Transform({ transform(chunk: Buffer, _encoding, done) {
      received += chunk.length;
      if (received > size) { done(new Error('Runtime download exceeds its published size.')); return; }
      hash.update(chunk);
      if (Date.now() - last > 300) { progress(received); last = Date.now(); }
      done(null, chunk);
    } });
    await pipeline(input, meter, createWriteStream(temp, { flags: 'wx' }));
    if (received !== size || hash.digest('hex').toLowerCase() !== checksum.toLowerCase()) throw new Error('Runtime download checksum or size mismatch. Retry setup.');
    await fs.rename(temp, target); progress(received);
  } finally { await fs.rm(temp, { force: true }); }
}
