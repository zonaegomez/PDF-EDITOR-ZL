// PDF -> layered editable model, using MuPDF (WASM). Runs in a Web Worker in the browser and in Node for tests.
//
// Each page becomes three layers:
//   bg     : the page rendered with every text run and raster image removed (vector art, fills, rules stay)
//   frames : raster images as independent frames { x, y, w, h, a }  (a = asset id)
//   lines  : text lines anchored on their exact baseline, with style runs and a justification flag
//
// Coordinates are PDF points, origin top-left, y down.

const BG_SCALE = 2;     // background resolution: 2 px per pt (144 dpi)
const MAX_IMG = 2000;   // longest side for extracted photos

export function fontFamilyOf(name) {
  const n = (name || "").toLowerCase().replace(/^[a-z]{6}\+/, "");
  if (/dejavu/.test(n)) return n.includes("mono") ? "mono" : n.includes("serif") ? "serif" : "dejavu";
  if (/times|georgia|garamond|serif|minion|cambria|book/.test(n) && !/sans/.test(n)) return "serif";
  if (/courier|mono|consol/.test(n)) return "mono";
  return "sans"; // Helvetica, Arial, Calibri, Inter, Montserrat... -> metric-compatible sans
}

const hex = (rgb) => "#" + rgb.map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, "0")).join("");
function colorToHex(c) {
  if (!c || !c.length) return "#000000";
  if (c.length === 1) return hex([c[0], c[0], c[0]]);
  if (c.length === 3) return hex(c);
  const [C, M, Y, K] = c; return hex([(1 - C) * (1 - K), (1 - M) * (1 - K), (1 - Y) * (1 - K)]);
}
const r2 = (v) => Math.round(v * 100) / 100;

function hashBytes(u8) {
  let h = 2166136261 >>> 0; const step = Math.max(1, Math.floor(u8.length / 4096));
  for (let i = 0; i < u8.length; i += step) { h ^= u8[i]; h = Math.imul(h, 16777619) >>> 0; }
  return (h ^ u8.length).toString(36);
}

export function convert(mupdf, bytes, { onProgress, fileName } = {}) {
  const doc = mupdf.Document.openDocument(bytes, "application/pdf");
  const bgDoc = mupdf.Document.openDocument(bytes.slice(0), "application/pdf"); // copy we redact for backgrounds
  const n = doc.countPages();
  const assets = {};
  const imgCache = new Map();
  const fontsUsed = {};
  const pages = [];

  for (let pi = 0; pi < n; pi++) {
    const page = doc.loadPage(pi);
    const [bx0, by0, bx1, by1] = page.getBounds();
    const W = bx1 - bx0, H = by1 - by0;

    // ---------- text: collect chars per stext line
    const blocks = [];
    let blk = null, line = null;
    page.toStructuredText("preserve-whitespace").walk({
      beginTextBlock(bbox) { blk = { bbox, lines: [] }; blocks.push(blk); },
      beginLine(bbox, wmode, dir) { line = { dir: [Math.round(dir[0]), Math.round(dir[1])], chars: [] }; blk && blk.lines.push(line); },
      onChar(c, origin, font, size, quad, color) {
        if (!line) return;
        const name = font.getName();
        const bold = font.isBold() || /bold|black|heavy|semibold/i.test(name);
        const fam = fontFamilyOf(name);
        fontsUsed[name.replace(/^[A-Z]{6}\+/, "")] = fam;
        const xs = [quad[0], quad[2], quad[4], quad[6]], ys = [quad[1], quad[3], quad[5], quad[7]];
        line.chars.push({ c, ox: origin[0] - bx0, oy: origin[1] - by0, size, col: colorToHex(color), b: bold ? 1 : 0, f: fam,
          x0: Math.min(...xs) - bx0, x1: Math.max(...xs) - bx0, y0: Math.min(...ys) - by0, y1: Math.max(...ys) - by0 });
      },
      endLine() { line = null; },
      endTextBlock() { blk = null; },
    });

    const lines = [];
    for (const b of blocks) {
      // fragments = runs of chars inside a stext line, split where the style changes
      const frags = [];
      for (const ln of b.lines) {
        let cur = null;
        for (const ch of ln.chars) {
          const st = { b: ch.b, s: r2(ch.size), c: ch.col, f: ch.f };
          if (cur && cur.st.b === st.b && cur.st.s === st.s && cur.st.c === st.c && cur.st.f === st.f) {
            cur.t += ch.c; cur.x1 = Math.max(cur.x1, ch.x1); cur.y0 = Math.min(cur.y0, ch.y0); cur.end = ch;
          } else {
            cur = { dir: ln.dir, st, t: ch.c, first: ch, end: ch, x0: ch.x0, x1: ch.x1, y0: ch.y0 }; frags.push(cur);
          }
        }
      }
      // group fragments sharing a baseline (+ direction), then split on wide gaps (e.g. eyebrow + page number)
      const groups = new Map();
      for (const fr of frags) {
        const horiz = fr.dir[0] === 1 && fr.dir[1] === 0;
        const key = fr.dir.join(",") + "|" + (horiz ? fr.first.oy : fr.first.ox).toFixed(1);
        if (!groups.has(key)) groups.set(key, { horiz, dir: fr.dir, frags: [] });
        groups.get(key).frags.push(fr);
      }
      const blockLines = [];
      for (const g of groups.values()) {
        const pos = (f) => g.horiz ? [f.first.ox, f.x1] : [-f.first.oy, -f.y0];
        g.frags.sort((a, c) => pos(a)[0] - pos(c)[0]);
        let run = [];
        const flush = () => {
          if (!run.length) return;
          const runs = [];
          for (const f of run) {
            const L = runs[runs.length - 1];
            if (L && L.st.b === f.st.b && L.st.s === f.st.s && L.st.c === f.st.c && L.st.f === f.st.f) L.t += f.t;
            else runs.push({ st: { ...f.st }, t: f.t });
          }
          const text = runs.map((r) => r.t).join("");
          if (text.trim()) {
            runs[runs.length - 1].t = runs[runs.length - 1].t.replace(/\s+$/, "");
            runs[0].t = runs[0].t.replace(/^\s+/, "") || runs[0].t;
            const f0 = run[0], fl = run[run.length - 1];
            const rot = g.horiz ? 0 : (g.dir[1] < 0 ? -90 : 90);
            const len = g.horiz ? fl.x1 - f0.first.ox : f0.first.oy - fl.y0;
            blockLines.push({ x: r2(f0.first.ox), y: r2(f0.first.oy), w: r2(len), rot, runs });
          }
          run = [];
        };
        for (const f of g.frags) {
          if (run.length) {
            const prev = run[run.length - 1];
            const gap = pos(f)[0] - pos(prev)[1];
            const same = prev.st.b === f.st.b && prev.st.s === f.st.s && prev.st.c === f.st.c;
            if (gap > 3 * f.st.s || (!same && gap > 1)) flush();
          }
          run.push(f);
        }
        flush();
      }
      // justification: lines (not the last) reaching the block's right edge and containing spaces
      const horiz = blockLines.filter((l) => l.rot === 0).sort((a, c) => a.y - c.y);
      const right = b.bbox[2] - bx0;
      horiz.forEach((l, i) => {
        const txt = l.runs.map((r) => r.t).join("");
        l.j = horiz.length > 1 && i < horiz.length - 1 && Math.abs(l.x + l.w - right) < 1.5 && /\S \S/.test(txt) ? 1 : 0;
      });
      blockLines.forEach((l) => { if (l.j === undefined) l.j = 0; lines.push(l); });
    }

    // ---------- images: capture every raster image the page paints, with its placement
    const frames = [];
    const dev = new mupdf.Device({
      fillImage(image, ctm) {
        const cx = [ctm[4], ctm[0] + ctm[4], ctm[2] + ctm[4], ctm[0] + ctm[2] + ctm[4]];
        const cy = [ctm[5], ctm[1] + ctm[5], ctm[3] + ctm[5], ctm[1] + ctm[3] + ctm[5]];
        let x0 = Math.max(0, Math.min(...cx) - bx0), y0 = Math.max(0, Math.min(...cy) - by0);
        let x1 = Math.min(W, Math.max(...cx) - bx0), y1 = Math.min(H, Math.max(...cy) - by0);
        if (x1 - x0 < 4 || y1 - y0 < 4) return;
        const id = assetFor(image);
        if (id) frames.push({ x: r2(x0), y: r2(y0), w: r2(x1 - x0), h: r2(y1 - y0), a: id });
      },
    });
    page.run(dev, mupdf.Matrix.identity);
    dev.close?.();

    function assetFor(image) {
      const iw = image.getWidth(), ih = image.getHeight();
      const k = Math.min(1, MAX_IMG / Math.max(iw, ih));
      const w = Math.max(1, Math.round(iw * k)), h = Math.max(1, Math.round(ih * k));
      const draw = (img, cs, bgv) => {
        const p = new mupdf.Pixmap(cs, [0, 0, w, h], false); p.clear(bgv);
        const d = new mupdf.DrawDevice(mupdf.Matrix.identity, p); d.fillImage(img, [w, 0, 0, h, 0, 0], 1); d.close();
        return p;
      };
      const rgb = draw(image, mupdf.ColorSpace.DeviceRGB, 255);
      const maskImg = image.getMask && image.getMask();
      let data, mime;
      if (maskImg) {
        // soft mask: combine colour + mask into RGBA ourselves (the draw device ignores the mask here)
        const mp = maskImg.toPixmap();
        const mw = mp.getWidth(), mh = mp.getHeight(), ms = mp.getStride(), mn = Math.round(ms / mw);
        const rgba = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, w, h], true);
        // take views only after every allocation: WASM memory growth detaches earlier views
        const mpx = mp.getPixels().slice();
        const c = rgb.getPixels().slice();
        const out = rgba.getPixels();
        for (let i = 0, j = 0, k = 0; k < w * h; k++, i += 3, j += 4) {
          const px = k % w, py = (k / w) | 0;
          const a = mpx[Math.min(mh - 1, (py * mh / h) | 0) * ms + Math.min(mw - 1, (px * mw / w) | 0) * mn];
          out[j] = c[i] * a / 255; out[j + 1] = c[i + 1] * a / 255; out[j + 2] = c[i + 2] * a / 255; out[j + 3] = a; // premultiplied
        }
        data = rgba.asPNG(); mime = "image/png";
      } else { data = rgb.asJPEG(84); mime = "image/jpeg"; }
      const key = mime + hashBytes(data);
      if (imgCache.has(key)) return imgCache.get(key);
      const id = "a" + key.slice(-8) + imgCache.size;
      assets[id] = { mime, bytes: new Uint8Array(data), w, h };
      imgCache.set(key, id);
      return id;
    }

    // ---------- background: redact all text + images on the copy, keep line art
    const bp = bgDoc.loadPage(pi);
    const annot = bp.createAnnotation("Redact");
    annot.setRect(bp.getBounds());
    bp.applyRedactions(false, mupdf.PDFPage.REDACT_IMAGE_REMOVE, mupdf.PDFPage.REDACT_LINE_ART_NONE, mupdf.PDFPage.REDACT_TEXT_REMOVE);
    const bgPix = bp.toPixmap(mupdf.Matrix.scale(BG_SCALE, BG_SCALE), mupdf.ColorSpace.DeviceRGB, false, false);
    const bg = new Uint8Array(bgPix.asPNG());

    pages.push({ w: r2(W), h: r2(H), bg, lines, frames });
    onProgress && onProgress(pi + 1, n);
  }

  const title = (doc.getMetaData(mupdf.Document.META_INFO_TITLE) || "").trim() ||
    (fileName || "Documento").replace(/\.pdf$/i, "");
  return { title, pages, assets, fonts: fontsUsed };
}
