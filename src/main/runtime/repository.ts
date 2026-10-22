import { DOMParser } from '@xmldom/xmldom';
import { officialUrl } from './download';

export interface RuntimePackage {
  id: string; url: string; size: number; algorithm: string; checksum: string;
  licenseId: string; licenseText: string; revision: number[];
}
const child = (node: Element, name: string): Element | undefined => Array.from(node.childNodes)
  .find((n): n is Element => n.nodeType === 1 && (n as Element).localName === name);
const text = (node: Element | undefined) => node?.textContent?.trim() ?? '';
const children = (node: Element, name: string): Element[] => Array.from(node.childNodes)
  .filter((n): n is Element => n.nodeType === 1 && (n as Element).localName === name);

/** Select stable archives for the host and retain the exact vendor license. */
export function repositoryPackages(xml: string, base: string, host: 'macosx' | 'windows', arch: string): RuntimePackage[] {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('Unsupported repository XML declaration.');
  const document = new DOMParser({ errorHandler: { warning: () => undefined, error: (m) => { throw new Error(m); }, fatalError: (m) => { throw new Error(m); } } }).parseFromString(xml, 'text/xml');
  const root = document.documentElement, licenses = new Map<string, string>();
  for (const license of children(root, 'license')) licenses.set(license.getAttribute('id') ?? '', text(license));
  const packages: RuntimePackage[] = [];
  for (const pkg of children(root, 'remotePackage')) {
    if (child(pkg, 'obsolete') || (child(pkg, 'channelRef')?.getAttribute('ref') ?? 'channel-0') !== 'channel-0') continue;
    const id = pkg.getAttribute('path') ?? '', revision = child(pkg, 'revision');
    for (const archive of children(child(pkg, 'archives') ?? pkg, 'archive')) {
      const os = text(child(archive, 'host-os')), cpu = text(child(archive, 'host-arch')), bits = text(child(archive, 'host-bits'));
      if (os && os !== host) continue;
      if (bits && bits !== '64') continue;
      if (cpu && !(arch === 'arm64' ? ['aarch64', 'arm64'].includes(cpu) : ['x86_64', 'x64'].includes(cpu))) continue;
      const complete = child(archive, 'complete'); if (!complete) continue;
      const relative = text(child(complete, 'url'));
      // SDK archives without host-arch use filenames to distinguish Apple Silicon.
      if (id === 'emulator' && host === 'macosx' && !cpu) {
        if (arch === 'arm64' && !/aarch64|arm64/.test(relative)) continue;
        if (arch !== 'arm64' && /aarch64|arm64/.test(relative)) continue;
      }
      const checksum = child(complete, 'checksum'), licenseId = child(pkg, 'uses-license')?.getAttribute('ref') ?? '';
      const url = officialUrl(new URL(relative, base).href).href;
      const licenseText = licenses.get(licenseId);
      if (!licenseText || !checksum) continue;
      packages.push({ id, url, size: Number(text(child(complete, 'size'))), algorithm: checksum.getAttribute('type') || 'sha1', checksum: text(checksum),
        licenseId, licenseText, revision: ['major', 'minor', 'micro'].map((n) => Number(text(revision ? child(revision, n) : undefined)) || 0) });
    }
  }
  return packages;
}
export function latestPackage(packages: RuntimePackage[], id: string): RuntimePackage {
  const found = packages.filter((p) => p.id === id).sort((a, b) => {
    for (let i = 0; i < 3; i++) if (a.revision[i] !== b.revision[i]) return b.revision[i] - a.revision[i];
    return 0;
  })[0];
  if (!found) throw new Error(`No supported official runtime archive found for ${id}.`);
  return found;
}
