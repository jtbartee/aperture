// Portable project files (.aperture = zip): project.json + every referenced image asset.
// The original image is always packaged — a portable project never silently drops its score.

import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import type { Project } from '../core/types';
import { normalizeProject } from '../state/project';

export interface PackedAsset { id: string; name: string; mime: string; bytes: Uint8Array }

const ext = (mime: string) => (mime.includes('png') ? 'png' : mime.includes('webp') ? 'webp' : mime.includes('gif') ? 'gif' : 'jpg');

export function referencedAssets(p: Project): string[] {
  return [p.image?.asset.assetId, p.panorama?.asset.assetId].filter((x): x is string => !!x);
}

export function packProject(p: Project, assets: PackedAsset[]): Uint8Array {
  const files: Record<string, Uint8Array> = {
    'project.json': strToU8(JSON.stringify(p)),
    'manifest.json': strToU8(JSON.stringify({ app: 'APERTURE', format: 'aperture-project', version: 1, assets: assets.map((a) => ({ id: a.id, name: a.name, mime: a.mime, file: `assets/${a.id}.${ext(a.mime)}` })) })),
  };
  for (const a of assets) files[`assets/${a.id}.${ext(a.mime)}`] = a.bytes;
  return zipSync(files, { level: 6 });
}

export function unpackProject(bytes: Uint8Array): { project: Project; assets: PackedAsset[] } {
  let files: Record<string, Uint8Array>;
  try { files = unzipSync(bytes); } catch { throw new Error('This file is not an APERTURE project (.aperture zip).'); }
  if (!files['project.json']) throw new Error('The project file is missing project.json.');
  const raw = JSON.parse(strFromU8(files['project.json']));
  if (raw?.format !== 'aperture-project') throw new Error('project.json is not an APERTURE project.');
  const manifest = files['manifest.json'] ? JSON.parse(strFromU8(files['manifest.json'])) : { assets: [] };
  const assets: PackedAsset[] = [];
  for (const a of manifest.assets ?? []) {
    const data = files[a.file];
    if (data) assets.push({ id: a.id, name: a.name, mime: a.mime, bytes: data });
  }
  const project = normalizeProject(raw);
  const missing = referencedAssets(project).filter((id) => !assets.some((a) => a.id === id));
  if (missing.length) throw new Error(`The project references ${missing.length} image(s) that are not inside the file.`);
  return { project, assets };
}
