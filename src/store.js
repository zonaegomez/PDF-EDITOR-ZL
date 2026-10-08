// Local drafts in IndexedDB: the original PDF plus the edits on top of it.
// Lives only in this browser on this device; nothing leaves the machine.
const DB = "zl-pdf-editor", STORE = "drafts", MAX_DRAFTS = 8;

function db() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: "key" });
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function tx(mode, fn) {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction(STORE, mode), s = t.objectStore(STORE);
    let out; Promise.resolve(fn(s)).then((v) => (out = v));
    t.oncomplete = () => { d.close(); res(out); };
    t.onerror = t.onabort = () => { d.close(); rej(t.error); };
  });
}
const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

/** Stable key for a PDF: name + size + sampled content hash (same file → same draft) */
export async function keyFor(name, bytes) {
  const u8 = new Uint8Array(bytes);
  let h = 2166136261 >>> 0; const step = Math.max(1, Math.floor(u8.length / 65536));
  for (let i = 0; i < u8.length; i += step) { h ^= u8[i]; h = Math.imul(h, 16777619) >>> 0; }
  return `${name}|${u8.length}|${h.toString(36)}`;
}

export async function saveDraft(rec) {
  await tx("readwrite", (s) => s.put({ ...rec, savedAt: Date.now() }));
  const all = await listDrafts();
  for (const old of all.slice(MAX_DRAFTS)) await deleteDraft(old.key);
}
export const getDraft = (key) => tx("readonly", (s) => req(s.get(key)));
export const deleteDraft = (key) => tx("readwrite", (s) => s.delete(key));
/** Drafts newest first, without the heavy PDF bytes */
export async function listDrafts() {
  const all = (await tx("readonly", (s) => req(s.getAll()))) || [];
  return all.map(({ pdf, edits, ...meta }) => ({ ...meta, nLines: edits?.lines?.length || 0, nFrames: edits?.frames?.length || 0 }))
    .sort((a, b) => b.savedAt - a.savedAt);
}
export const storageAvailable = () => { try { return !!window.indexedDB; } catch { return false; } };
