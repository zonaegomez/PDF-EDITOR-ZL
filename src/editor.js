// Layered editor: background image + image frames + baseline-anchored editable text lines.
import { cssFamily } from "./fonts.js";

const $ = (s) => document.querySelector(s);

export function createEditor({ desk, onChange }) {
  const state = { model: null, scale: 1, sel: null, mode: "move", assets: {}, frames: [], lines: [], urls: [] };
  const mctx = document.createElement("canvas").getContext("2d");
  const textW = (t, st) => { mctx.font = (st.b ? "700 " : "400 ") + st.s * 10 + "px " + cssFamily(st.f); return mctx.measureText(t).width / 10; };

  /* ---------- build ---------- */
  function load(model) {
    clear();
    state.model = model;
    for (const [id, a] of Object.entries(model.assets)) {
      const url = URL.createObjectURL(new Blob([a.bytes], { type: a.mime }));
      state.urls.push(url);
      state.assets[id] = { src: url, w: a.w, h: a.h, mime: a.mime, bytes: a.bytes };
    }
    desk.innerHTML = "";
    model.pages.forEach((p, pi) => {
      const wrap = document.createElement("section"); wrap.className = "pwrap"; wrap.setAttribute("aria-label", "Página " + (pi + 1));
      const num = document.createElement("div"); num.className = "pnum";
      num.textContent = String(pi + 1).padStart(2, "0") + " / " + String(model.pages.length).padStart(2, "0");
      const page = document.createElement("div"); page.className = "page"; page.style.width = p.w + "px"; page.style.height = p.h + "px";
      const bgUrl = URL.createObjectURL(new Blob([p.bg], { type: "image/png" })); state.urls.push(bgUrl);
      const bg = new Image(); bg.className = "bg"; bg.alt = ""; bg.src = bgUrl; page.append(bg);

      p.frames.forEach((f) => {
        const st = { page: pi, x: f.x, y: f.y, w: f.w, h: f.h, a: f.a, z: 1, ox: 0, oy: 0, orig: { ...f } };
        const el = document.createElement("div"); el.className = "frame"; el.tabIndex = 0;
        el.setAttribute("role", "img"); el.setAttribute("aria-label", "Imagen editable de la página " + (pi + 1));
        const clip = document.createElement("div"); clip.className = "clip";
        const img = new Image(); img.alt = ""; img.draggable = false; img.src = state.assets[f.a].src; clip.append(img);
        const gw = document.createElement("div"); gw.className = "ghostwrap";
        const g = new Image(); g.className = "ghost"; g.alt = ""; g.src = img.src; gw.append(g);
        el.append(clip, gw);
        ["nw", "ne", "sw", "se"].forEach((k) => { const h = document.createElement("div"); h.className = "h " + k; h.dataset.h = k; h.hidden = true; el.append(h); });
        st.el = el; st.img = img; st.ghost = g; el._f = st; state.frames.push(st); page.append(el); layoutFrame(st);
      });

      p.lines.forEach((l) => {
        const el = document.createElement("div"); el.className = "line" + (l.j ? " j" : "");
        el.contentEditable = "true"; el.spellcheck = true; el.setAttribute("role", "textbox"); el.setAttribute("aria-label", "Texto editable");
        const r0 = l.runs[0].st;
        el.style.fontFamily = cssFamily(r0.f) + ",sans-serif"; el.style.fontSize = r0.s + "px"; el.style.color = r0.c; el.style.fontWeight = r0.b ? 700 : 400;
        const mk = document.createElement("span"); mk.style.cssText = "display:inline-block;width:0;height:0;vertical-align:baseline"; el.append(mk);
        l.runs.forEach((r) => {
          const s = document.createElement("span"); s.textContent = r.t;
          s.style.cssText = `font-family:${cssFamily(r.st.f)},sans-serif;font-size:${r.st.s}px;color:${r.st.c};font-weight:${r.st.b ? 700 : 400}`;
          Object.assign(s.dataset, { s: r.st.s, c: r.st.c, b: r.st.b, f: r.st.f }); el.append(s);
        });
        if (l.j) el.style.width = l.w + "px";
        el.style.left = l.x + "px";
        el._l = l; el._orig = l.runs.map((r) => r.t).join("");
        page.append(el); state.lines.push({ page: pi, data: l, el });
      });
      wrap.append(num, page); wrap._page = page; wrap._p = p; desk.append(wrap);
    });
    // baseline alignment: each line's baseline lands exactly on the PDF baseline
    state.lines.forEach(({ data: l, el }) => {
      const mk = el.firstChild, b = mk.offsetTop; mk.remove();
      el.style.top = l.y - b + "px";
      if (l.rot) { el.style.transformOrigin = "0 " + b + "px"; el.style.transform = "rotate(" + l.rot + "deg)"; }
    });
    fitWidth();
    state.lines.forEach(({ el }) => checkLine(el));
    emit();
  }

  function clear() {
    state.urls.forEach((u) => URL.revokeObjectURL(u));
    Object.assign(state, { model: null, sel: null, assets: {}, frames: [], lines: [], urls: [] });
    desk.innerHTML = "";
  }

  /* ---------- view zoom ---------- */
  function applyScale() {
    desk.querySelectorAll(".pwrap").forEach((w) => {
      const p = w._p; w.style.width = p.w * state.scale + "px"; w.style.height = p.h * state.scale + "px";
      w._page.style.transform = "scale(" + state.scale + ")";
    });
    emit();
  }
  function fitWidth() {
    if (!state.model) return;
    const avail = desk.clientWidth - 32, W = Math.max(...state.model.pages.map((p) => p.w));
    state.scale = Math.max(0.3, Math.min(1.6, avail / W)); applyScale();
  }
  const zoom = (k) => { state.scale = Math.max(0.3, Math.min(3, state.scale * k)); applyScale(); };

  /* ---------- text ---------- */
  function runsOf(el) {
    const base = el._l.runs[0].st, out = [];
    const push = (t, st) => {
      t = t.replace(/ /g, " ").replace(/[\r\n\t]+/g, " "); if (!t) return;
      const L = out[out.length - 1];
      if (L && L.st.b == st.b && L.st.s == st.s && L.st.c == st.c && L.st.f == st.f) L.t += t; else out.push({ t, st: { ...st } });
    };
    const walk = (n, st) => n.childNodes.forEach((c) => {
      if (c.nodeType === 3) push(c.textContent, st);
      else if (c.nodeType === 1 && c.tagName !== "BR") {
        const d = c.dataset || {};
        walk(c, d.s ? { b: +d.b, s: +d.s, c: d.c, f: d.f } : st);
      }
    });
    walk(el, { ...base });
    return out;
  }
  function checkLine(el) {
    const runs = runsOf(el), l = el._l;
    const nat = runs.reduce((a, r) => a + textW(r.t, r.st), 0);
    el.classList.toggle("over", nat > l.w * 1.02 + 1);
    el.classList.toggle("dirty", runs.map((r) => r.t).join("") !== el._orig);
  }

  desk.addEventListener("input", (e) => { if (e.target.classList?.contains("line")) { checkLine(e.target); emit(); } });
  desk.addEventListener("keydown", (e) => {
    const t = e.target;
    if (!t.classList?.contains("line") || e.key !== "Enter") return;
    e.preventDefault();
    const pg = state.lines.find((x) => x.el === t).page;
    const list = state.lines.filter((x) => x.page === pg).map((x) => x.el).sort((a, b) => a._l.y - b._l.y || a._l.x - b._l.x);
    const n = list[list.indexOf(t) + 1];
    if (n) { n.focus(); const r = document.createRange(); r.selectNodeContents(n); r.collapse(false); const s = getSelection(); s.removeAllRanges(); s.addRange(r); }
  });
  desk.addEventListener("paste", (e) => {
    if (!e.target.closest?.(".line")) return;
    e.preventDefault();
    document.execCommand("insertText", false, (e.clipboardData.getData("text/plain") || "").replace(/\s+/g, " "));
  });

  /* ---------- images ---------- */
  function geom(f) {
    const a = state.assets[f.a], s = Math.max(f.w / a.w, f.h / a.h) * f.z, dw = a.w * s, dh = a.h * s;
    const mx = (dw - f.w) / 2, my = (dh - f.h) / 2;
    f.ox = Math.max(-mx, Math.min(mx, f.ox)); f.oy = Math.max(-my, Math.min(my, f.oy));
    return { dw, dh, left: (f.w - dw) / 2 + f.ox, top: (f.h - dh) / 2 + f.oy };
  }
  function layoutFrame(f) {
    const g = geom(f), e = f.el.style;
    e.left = f.x + "px"; e.top = f.y + "px"; e.width = f.w + "px"; e.height = f.h + "px";
    for (const im of [f.img, f.ghost]) Object.assign(im.style, { width: g.dw + "px", height: g.dh + "px", left: g.left + "px", top: g.top + "px" });
    if (state.sel === f) emit();
  }
  const isDirtyFrame = (f) => {
    const o = f.orig;
    return f.a !== o.a || Math.abs(f.x - o.x) > 0.01 || Math.abs(f.y - o.y) > 0.01 || Math.abs(f.w - o.w) > 0.01 || Math.abs(f.h - o.h) > 0.01 || f.z !== 1 || f.ox || f.oy;
  };
  function select(f) {
    if (state.sel) { state.sel.el.classList.remove("sel", "pan"); state.sel.el.querySelectorAll(".h").forEach((h) => (h.hidden = true)); }
    state.sel = f || null;
    if (f) {
      f.el.classList.add("sel"); f.el.classList.toggle("pan", state.mode === "pan");
      f.el.querySelectorAll(".h").forEach((h) => (h.hidden = state.mode === "pan"));
      layoutFrame(f);
    }
    emit();
  }
  function setMode(m) { state.mode = m; if (state.sel) select(state.sel); else emit(); }
  function setZoom(z) { if (!state.sel) return; state.sel.z = z; layoutFrame(state.sel); emit(); }
  function resetSel() {
    const f = state.sel; if (!f) return;
    Object.assign(f, { x: f.orig.x, y: f.orig.y, w: f.orig.w, h: f.orig.h, a: f.orig.a, z: 1, ox: 0, oy: 0 });
    f.img.src = f.ghost.src = state.assets[f.a].src; layoutFrame(f); emit();
  }
  async function replaceSel(file) {
    const f = state.sel; if (!f || !file) return;
    const url = URL.createObjectURL(file); state.urls.push(url);
    const im = new Image();
    await new Promise((res, rej) => { im.onload = res; im.onerror = () => rej(new Error("No se pudo leer esa imagen. Prueba con JPG o PNG.")); im.src = url; });
    const id = "u" + Date.now();
    state.assets[id] = { src: url, w: im.naturalWidth, h: im.naturalHeight, mime: file.type === "image/png" ? "image/png" : "image/jpeg", img: im };
    Object.assign(f, { a: id, z: 1, ox: 0, oy: 0 });
    f.img.src = f.ghost.src = url; layoutFrame(f); emit();
  }

  let drag = null;
  desk.addEventListener("pointerdown", (e) => {
    const fe = e.target.closest(".frame");
    if (!fe) { select(null); return; }
    const f = fe._f;
    if (state.sel !== f) { select(f); if (e.pointerType === "touch") return; }
    drag = { f, h: e.target.dataset?.h, sx: e.clientX, sy: e.clientY, start: { x: f.x, y: f.y, w: f.w, h: f.h, ox: f.ox, oy: f.oy }, moved: false };
    fe.setPointerCapture?.(e.pointerId); e.preventDefault();
  });
  window.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const { f, h, start: s } = drag, dx = (e.clientX - drag.sx) / state.scale, dy = (e.clientY - drag.sy) / state.scale;
    if (!drag.moved && Math.hypot(dx, dy) < 1.5) return;
    drag.moved = true;
    if (h) {
      let x = s.x, y = s.y, w = s.w, hh = s.h;
      if (h.includes("e")) w = s.w + dx; if (h.includes("s")) hh = s.h + dy;
      if (h.includes("w")) { w = s.w - dx; x = s.x + dx; } if (h.includes("n")) { hh = s.h - dy; y = s.y + dy; }
      if (e.shiftKey) {
        const r = s.w / s.h;
        if (Math.abs(w - s.w) / s.w > Math.abs(hh - s.h) / s.h) { const nh = w / r; if (h.includes("n")) y = s.y + s.h - nh; hh = nh; }
        else { const nw = hh * r; if (h.includes("w")) x = s.x + s.w - nw; w = nw; }
      }
      if (w < 16) { if (h.includes("w")) x = s.x + s.w - 16; w = 16; }
      if (hh < 16) { if (h.includes("n")) y = s.y + s.h - 16; hh = 16; }
      Object.assign(f, { x, y, w, h: hh });
    } else if (state.mode === "pan") { f.ox = s.ox + dx; f.oy = s.oy + dy; }
    else { f.x = s.x + dx; f.y = s.y + dy; }
    layoutFrame(f);
  });
  window.addEventListener("pointercancel", () => (drag = null));
  window.addEventListener("pointerup", () => { if (drag) { if (drag.moved) emit(); drag = null; } });
  desk.addEventListener("dblclick", (e) => { if (e.target.closest(".frame")) setMode(state.mode === "pan" ? "move" : "pan"); });
  window.addEventListener("keydown", (e) => {
    const f = state.sel;
    if (!f || e.target.closest?.(".line") || e.target.tagName === "INPUT") return;
    if (e.key === "Escape") { select(null); return; }
    const k = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
    if (!k) return;
    e.preventDefault(); const n = e.shiftKey ? 10 : 1;
    if (state.mode === "pan") { f.ox += k[0] * n; f.oy += k[1] * n; } else { f.x += k[0] * n; f.y += k[1] * n; }
    layoutFrame(f); emit();
  });
  desk.addEventListener("wheel", (e) => {
    const f = state.sel;
    if (!f || !e.target.closest(".frame.sel") || !(e.ctrlKey || e.metaKey || state.mode === "pan")) return;
    e.preventDefault(); f.z = Math.max(1, Math.min(4, f.z * (e.deltaY < 0 ? 1.06 : 1 / 1.06))); layoutFrame(f); emit();
  }, { passive: false });

  /* ---------- status ---------- */
  function status() {
    const over = desk.querySelectorAll(".line.over").length, dl = desk.querySelectorAll(".line.dirty").length;
    const di = state.frames.filter(isDirtyFrame).length, f = state.sel;
    return {
      scale: state.scale, over, dirtyLines: dl, dirtyFrames: di, mode: state.mode,
      sel: f ? { w: f.w, h: f.h, z: f.z } : null,
    };
  }
  const emit = () => onChange && onChange(status());

  return {
    load, clear, zoom, fitWidth, setMode, setZoom, resetSel, replaceSel, select, status, geom, runsOf, isDirtyFrame,
    get state() { return state; },
  };
}
