// .zlpdf project file: the original PDF + edits + added images + uploaded fonts in one binary file.
// Layout: "ZLPDF1" | uint32 LE header length | UTF-8 JSON header | binary blobs (offsets in header)
const MAGIC = "ZLPDF1";

export function packProject({ fileName, pdf, edits }) {
  const blobs = []; let off = 0;
  const add = (u8) => { const ref = { off, len: u8.length }; blobs.push(u8); off += u8.length; return ref; };
  const pdfRef = add(new Uint8Array(pdf));
  const assets = {};
  for (const [id, a] of Object.entries(edits.assets || {})) assets[id] = { mime: a.mime, w: a.w, h: a.h, ...add(new Uint8Array(a.bytes)) };
  const fonts = {};
  for (const [id, f] of Object.entries(edits.fonts || {})) fonts[id] = { name: f.name, reg: add(f.reg), bold: f.bold ? add(f.bold) : null };
  const header = new TextEncoder().encode(JSON.stringify({
    v: 2, app: "zl-pdf-editor", fileName, savedAt: new Date().toISOString(),
    pdf: pdfRef, edits: { ...edits, assets, fonts },
  }));
  const len = new Uint8Array(4); new DataView(len.buffer).setUint32(0, header.length, true);
  return new Blob([new TextEncoder().encode(MAGIC), len, header, ...blobs], { type: "application/octet-stream" });
}

export async function unpackProject(file) {
  const buf = new Uint8Array(await file.arrayBuffer());
  if (new TextDecoder().decode(buf.subarray(0, 6)) !== MAGIC) throw new Error("Ese archivo no es un proyecto del Editor PDF.");
  const hlen = new DataView(buf.buffer, buf.byteOffset + 6, 4).getUint32(0, true);
  const head = JSON.parse(new TextDecoder().decode(buf.subarray(10, 10 + hlen)));
  const base = 10 + hlen, slice = (r) => buf.slice(base + r.off, base + r.off + r.len);
  const assets = {};
  for (const [id, a] of Object.entries(head.edits.assets || {})) assets[id] = { mime: a.mime, w: a.w, h: a.h, bytes: slice(a) };
  const fonts = {};
  for (const [id, f] of Object.entries(head.edits.fonts || {})) fonts[id] = { name: f.name, reg: slice(f.reg), bold: f.bold ? slice(f.bold) : null };
  return { fileName: head.fileName, pdf: slice(head.pdf).buffer, edits: { ...head.edits, assets, fonts } };
}

export const isProjectFile = (file) => /\.zlpdf$/i.test(file.name);
