import { convert } from "./convert.js";

// mupdf initialises its WASM with top-level await. Import it lazily so this handler is registered
// synchronously; otherwise the first message can arrive before the module finishes evaluating and be lost.
const mupdfReady = import("mupdf");

self.onmessage = async (e) => {
  const { bytes, fileName } = e.data;
  try {
    const mupdf = await mupdfReady;
    self.postMessage({ type: "progress", done: 0, total: 1 });
    const model = convert(mupdf, new Uint8Array(bytes), {
      fileName,
      onProgress: (done, total) => self.postMessage({ type: "progress", done, total }),
    });
    const transfer = [];
    model.pages.forEach((p) => transfer.push(p.bg.buffer));
    Object.values(model.assets).forEach((a) => transfer.push(a.bytes.buffer));
    self.postMessage({ type: "done", model }, transfer);
  } catch (err) {
    const msg = String((err && err.message) || err);
    self.postMessage({ type: "error", message: /password|encrypt/i.test(msg) ? "El PDF está protegido con contraseña." : msg });
  }
};
