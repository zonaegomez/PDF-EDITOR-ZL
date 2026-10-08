// Rebuild a real PDF from the editor state: vector text with embedded fonts (selectable),
// background as one image per page, image frames re-cropped to their current framing.
import { PDFDocument, rgb, degrees } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { fontBytes } from "./fonts.js";

const hexRgb = (c) => { const n = parseInt(c.slice(1), 16); return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255); };

function loadImg(a) {
  if (a.img && a.img.complete) return Promise.resolve(a.img);
  return new Promise((res, rej) => { const i = new Image(); i.onload = () => { a.img = i; res(i); }; i.onerror = rej; i.src = a.src; });
}

async function frameBytes(editor, f) {
  const a = editor.state.assets[f.a], im = await loadImg(a), g = editor.geom(f);
  const dpp = Math.min(4, Math.max(2, a.w / g.dw)); // keep source resolution, at most 4 px per pt
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(f.w * dpp)); c.height = Math.max(1, Math.round(f.h * dpp));
  const x = c.getContext("2d"); x.imageSmoothingQuality = "high";
  x.drawImage(im, g.left * dpp, g.top * dpp, g.dw * dpp, g.dh * dpp);
  const png = a.mime === "image/png";
  const blob = await new Promise((r) => c.toBlob(r, png ? "image/png" : "image/jpeg", 0.9));
  return { bytes: new Uint8Array(await blob.arrayBuffer()), png };
}

export async function exportPdf(editor, onProgress) {
  const { model, frames, lines, assets } = editor.state;
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  pdf.setTitle(model.title); pdf.setCreator("Zona Luz · Editor PDF"); pdf.setProducer("zl-pdf-editor");

  const fonts = {}; // fam -> [regular, bold]
  const fontFor = async (st) => {
    if (!fonts[st.f]) { const [r, b] = await fontBytes(st.f); fonts[st.f] = [await pdf.embedFont(r, { subset: true }), await pdf.embedFont(b, { subset: true })]; }
    return fonts[st.f][st.b ? 1 : 0];
  };
  const cache = {};

  for (let pi = 0; pi < model.pages.length; pi++) {
    const p = model.pages[pi], pg = pdf.addPage([p.w, p.h]);
    pg.drawImage(await pdf.embedPng(p.bg), { x: 0, y: 0, width: p.w, height: p.h });

    for (const f of frames.filter((f) => f.page === pi)) {
      const clean = !editor.isDirtyFrame(f);
      let emb = clean ? cache[f.a] : null;
      if (!emb) {
        if (clean) { const a = assets[f.a]; emb = a.mime === "image/png" ? await pdf.embedPng(a.bytes) : await pdf.embedJpg(a.bytes); cache[f.a] = emb; }
        else { const r = await frameBytes(editor, f); emb = r.png ? await pdf.embedPng(r.bytes) : await pdf.embedJpg(r.bytes); }
      }
      pg.drawImage(emb, { x: f.x, y: p.h - f.y - f.h, width: f.w, height: f.h });
    }

    for (const { data: l, el } of lines.filter((x) => x.page === pi)) {
      const runs = editor.runsOf(el); if (!runs.length) continue;
      let nat = 0, spaces = 0;
      for (const r of runs) { nat += (await fontFor(r.st)).widthOfTextAtSize(r.t, r.st.s); spaces += (r.t.match(/ /g) || []).length; }
      const extra = l.j && spaces && nat < l.w ? (l.w - nat) / spaces : 0; // re-create justified spacing
      let adv = 0;
      for (const r of runs) {
        const font = await fontFor(r.st), color = hexRgb(r.st.c);
        // justified lines are drawn word by word; everything else as one string so it copies cleanly
        const parts = extra ? r.t.split(/( )/) : [r.t];
        for (const t of parts) {
          if (!t) continue;
          const w = font.widthOfTextAtSize(t, r.st.s);
          if (t !== " ") {
            if (l.rot) pg.drawText(t, { x: l.x, y: p.h - l.y + adv * (l.rot < 0 ? 1 : -1), size: r.st.s, font, color, rotate: degrees(-l.rot) });
            else pg.drawText(t, { x: l.x + adv, y: p.h - l.y, size: r.st.s, font, color });
          }
          adv += w + (t === " " ? extra : 0);
        }
      }
    }
    onProgress && onProgress(pi + 1, model.pages.length);
  }
  return pdf.save();
}
