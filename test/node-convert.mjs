import * as mupdf from "mupdf";
import fs from "fs";
import { convert } from "../src/convert.js";
const bytes = new Uint8Array(fs.readFileSync(process.argv[2]));
const t = Date.now();
const d = convert(mupdf, bytes, { fileName: "x.pdf" });
console.log("ms", Date.now() - t, "title", d.title, "fonts", d.fonts);
const sum = (f) => d.pages.reduce((a, p) => a + f(p), 0);
console.log("pages", d.pages.length, "lines", sum(p => p.lines.length), "frames", sum(p => p.frames.length), "assets", Object.keys(d.assets).length,
  "bgMB", (sum(p => p.bg.length) / 1e6).toFixed(2), "imgMB", (Object.values(d.assets).reduce((a, x) => a + x.bytes.length, 0) / 1e6).toFixed(2));
for (const l of d.pages[5].lines.slice(0, 8)) console.log(l.x, l.y, l.w, l.rot, l.j, l.runs.map(r => r.t + "|" + r.st.c + "|" + r.st.s + "|" + r.st.f).join(" + "));
console.log(d.pages[0].frames, d.pages[3].lines.filter(l=>l.runs.some(r=>r.st.b)).slice(0,2).map(l=>JSON.stringify(l)));
fs.writeFileSync("test/bg6.png", d.pages[5].bg);
const logo = d.pages[0].frames[0].a; fs.writeFileSync("test/logo." + (d.assets[logo].mime.endsWith("png") ? "png" : "jpg"), d.assets[logo].bytes);
fs.writeFileSync("test/model.json", JSON.stringify(d, (k, v) => v instanceof Uint8Array ? `<${v.length}b>` : v));
