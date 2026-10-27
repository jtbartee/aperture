// Local persistence in IndexedDB: projects (JSON) and image assets (Blobs). Nothing leaves the
// browser. Clearing site data deletes everything — the UI says so and offers portable downloads.

import type { Project } from '../core/types';

const DB = 'aperture';
const VERSION = 1;

export interface ProjectMeta { id: string; name: string; modified: number; created: number; workspace: string }

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('This browser has no IndexedDB; projects can only be saved as files.')); return; }
    const req = indexedDB.open(DB, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('projects')) db.createObjectStore('projects', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('assets')) db.createObjectStore('assets');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB failed to open'));
  });
}

let dbp: Promise<IDBDatabase> | null = null;
const db = () => (dbp ??= open());

function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T> {
  return db().then((d) => new Promise<T>((resolve, reject) => {
    const t = d.transaction(store, mode);
    const s = t.objectStore(store);
    const r = fn(s);
    let result: T;
    if (r) r.onsuccess = () => { result = r.result; };
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(friendly(t.error));
    t.onabort = () => reject(friendly(t.error));
  }));
}

function friendly(e: DOMException | null): Error {
  if (e && (e.name === 'QuotaExceededError' || /quota/i.test(e.message))) {
    return new Error('Browser storage is full. Download the project as a file (Export → Project file) or delete older projects.');
  }
  return new Error(e?.message ?? 'Storage error');
}

export const saveProject = (p: Project) => tx<IDBValidKey>('projects', 'readwrite', (s) => s.put(p));
export const loadProject = (id: string) => tx<Project | undefined>('projects', 'readonly', (s) => s.get(id));
export const deleteProject = (id: string) => tx<undefined>('projects', 'readwrite', (s) => s.delete(id));
export async function listProjects(): Promise<ProjectMeta[]> {
  const all = await tx<Project[]>('projects', 'readonly', (s) => s.getAll());
  return (all ?? []).map((p) => ({ id: p.id, name: p.name, modified: p.modified, created: p.created, workspace: p.workspace })).sort((a, b) => b.modified - a.modified);
}
export const putAsset = (id: string, blob: Blob) => tx<IDBValidKey>('assets', 'readwrite', (s) => s.put(blob, id));
export const getAsset = (id: string) => tx<Blob | undefined>('assets', 'readonly', (s) => s.get(id));
export const deleteAsset = (id: string) => tx<undefined>('assets', 'readwrite', (s) => s.delete(id));

export async function storageEstimate(): Promise<{ usage: number; quota: number } | null> {
  try {
    const e = await navigator.storage?.estimate?.();
    return e ? { usage: e.usage ?? 0, quota: e.quota ?? 0 } : null;
  } catch { return null; }
}

const LAST = 'aperture:lastProject';
export function lastProjectId(): string | null { try { return localStorage.getItem(LAST); } catch { return null; } }
export function setLastProjectId(id: string) { try { localStorage.setItem(LAST, id); } catch { /* private mode */ } }
