// Layered editor: background image + image frames + baseline-anchored editable text lines.
// One history stack covers text and images, so Ctrl+Z walks back through every kind of change in order.
import { cssFamily } from "./fonts.js";

const HISTORY_MAX = 300;
const TYPE_BURST_MS = 700;   // keystrokes closer than this become one undo step

export function createEditor({ desk, onChange, onEdit }) {
  const state = { model: null, scale: 1, sel: null, mode: "move", assets: {}, frames: [], lines: [], urls: [] };
  const hist = { undo: [], redo: [] };
  let pendingText = null;    // { el, before, timer }
  let pendingFrame = null;   // { f, before, timer }
  const mctx = document.createElement("canvas").getContext("2d");
  const textW = (t, st) => { mctx.font = (st.b ? "700 " : "400 ") + st.s * 10 + "px " + cssFamily(st.f); return mctx.measureText(t).width / 10; };

  /* ---------- build ---------- */
  function load(model) {
    clear();
    state.model = model;
    for (const [id, a] of Object.entries(model.assets)) registerAsset(id, a.bytes, a.mime, a.w, a.h, false);
    desk.innerHTML = "";
    model.pages.forEach((p, pi) => {
      const wrap = document.createElement("section"); wrap.className = "pwrap"; wrap.setAttribute("aria-label", "Página " + (pi + 1));
      const num = document.createElement("div"); num.className = "pnum";
      num.textContent = String(pi + 1).padStart(2, "0") + " / " + String(model.pages.length).padStart(2, "0");
      const page = document.createElement("div"); page.className = "page"; page.style.width = p.w + "px"; page.style.height = p.h + "px";
      const bgUrl = URL.createObjectURL(new Blob([p.bg], { type: "image/png" })); state.urls.push(bgUrl);
      const bg = new Image(); bg.className = "bg"; bg.alt = ""; bg.src = bgUrl; page.append(bg);

      p.frames.forEach((f, fi) => {
        const st = { id: pi + ":" + fi, page: pi, x: f.x, y: f.y, w: f.w, h: f.h, a: f.a, z: 1, ox: 0, oy: 0, orig: { ...f } };
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

      p.lines.forEach((l, li) => {
        const el = document.createElement("div"); el.className = "line" + (l.j ? " j" : "");
        el.contentEditable = "true"; el.spellcheck = true; el.setAttribute("role", "textbox"); el.setAttribute("aria-label", "Texto editable");
        const r0 = l.runs[0].st;
        el.style.fontFamily = cssFamily(r0.f) + ",sans-serif"; el.style.fontSize = r0.s + "px"; el.style.color = r0.c; el.style.fontWeight = r0.b ? 700 : 400;
        const mk = document.createElement("span"); mk.style.cssText = "display:inline-block;width:0;height:0;vertical-align:baseline"; el.append(mk);
        fillRuns(el, l.runs);
        if (l.j) el.style.width = l.w + "px";
        el.style.left = l.x + "px";
        el._l = l; el._id = pi + ":" + li; el._orig = l.runs.map((r) => r.t).join("");
        page.append(el); state.lines.push({ id: el._id, page: pi, data: l, el });
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

  function fillRuns(el, runs) {
    runs.forEach((r) => {
      const s = document.createElement("span"); s.textContent = r.t;
      s.style.cssText = `font-family:${cssFamily(r.st.f)},sans-serif;font-size:${r.st.s}px;color:${r.st.c};font-weight:${r.st.b ? 700 : 400}`;
      Object.assign(s.dataset, { s: r.st.s, c: r.st.c, b: r.st.b, f: r.st.f }); el.append(s);
    });
  }

  function registerAsset(id, bytes, mime, w, h, user) {
    const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
    state.urls.push(url);
    state.assets[id] = { src: url, w, h, mime, bytes, user };
  }

  function clear() {
    clearTimeout(pendingText?.timer); clearTimeout(pendingFrame?.timer);
    pendingText = pendingFrame = null; hist.undo = []; hist.redo = [];
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
  const lineKey = (runs) => JSON.stringify(runs);
  function setLine(el, runs, focus) {
    el.innerHTML = ""; fillRuns(el, runs); checkLine(el);
    if (focus) {
      el.focus({ preventScroll: true });
      const r = document.createRange(); r.selectNodeContents(el); r.collapse(false);
      const s = getSelection(); s.removeAllRanges(); s.addRange(r);
    }
  }
  function checkLine(el) {
    const runs = runsOf(el), l = el._l;
    const nat = runs.reduce((a, r) => a + textW(r.t, r.st), 0);
    el.classList.toggle("over", nat > l.w * 1.02 + 1);
    el.classList.toggle("dirty", runs.map((r) => r.t).join("") !== el._orig);
  }
  const isDirtyLine = (el) => lineKey(runsOf(el)) !== lineKey(el._l.runs.map((r) => ({ t: r.t, st: r.st })));

  // typing bursts → one history entry each
  function commitText() {
    if (!pendingText) return;
    clearTimeout(pendingText.timer);
    const { el, before } = pendingText; pendingText = null;
    const after = runsOf(el);
    if (lineKey(after) !== lineKey(before)) pushHistory({ kind: "text", id: el._id, before, after });
  }
  desk.addEventListener("beforeinput", (e) => {
    const el = e.target.closest?.(".line"); if (!el) return;
    if (e.inputType === "historyUndo" || e.inputType === "historyRedo") { e.preventDefault(); e.inputType === "historyUndo" ? undo() : redo(); return; }
    if (pendingText && pendingText.el !== el) commitText();
    commitFrame();
    if (!pendingText) pendingText = { el, before: runsOf(el) };
  });
  desk.addEventListener("input", (e) => {
    const el = e.target.closest?.(".line"); if (!el) return;
    checkLine(el); emit();
    if (pendingText) { clearTimeout(pendingText.timer); pendingText.timer = setTimeout(commitText, TYPE_BURST_MS); }
  });
  desk.addEventListener("focusout", (e) => { if (e.target.classList?.contains("line")) commitText(); });
  desk.addEventListener("keydown", (e) => {
    const t = e.target;
    if (!t.classList?.contains("line") || e.key !== "Enter") return;
    e.preventDefault(); commitText();
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
  const frameState = (f) => ({ x: f.x, y: f.y, w: f.w, h: f.h, a: f.a, z: f.z, ox: f.ox, oy: f.oy });
  const sameFrame = (a, b) => ["x", "y", "w", "h", "z", "ox", "oy"].every((k) => Math.abs(a[k] - b[k]) < 0.01) && a.a === b.a;
  function applyFrame(f, s) {
    const srcChanged = f.a !== s.a;
    Object.assign(f, s);
    if (srcChanged) f.img.src = f.ghost.src = state.assets[f.a].src;
    layoutFrame(f);
  }
  const isDirtyFrame = (f) => !sameFrame(frameState(f), { ...f.orig, z: 1, ox: 0, oy: 0 });

  // frame edits: begin captures "before", commit pushes one history step
  function beginFrame(f) {
    if (pendingFrame && pendingFrame.f !== f) commitFrame();
    commitText();
    if (!pendingFrame) pendingFrame = { f, before: frameState(f) };
  }
  function commitFrame() {
    if (!pendingFrame) return;
    clearTimeout(pendingFrame.timer);
    const { f, before } = pendingFrame; pendingFrame = null;
    const after = frameState(f);
    if (!sameFrame(before, after)) pushHistory({ kind: "frame", id: f.id, before, after });
  }
  function frameBurst(f) { beginFrame(f); clearTimeout(pendingFrame.timer); pendingFrame.timer = setTimeout(commitFrame, TYPE_BURST_MS); }

  function select(f) {
    commitFrame();
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
  function setZoom(z) { const f = state.sel; if (!f) return; frameBurst(f); f.z = z; layoutFrame(f); emit(); }
  function resetSel() {
    const f = state.sel; if (!f) return;
    beginFrame(f); applyFrame(f, { ...f.orig, z: 1, ox: 0, oy: 0 }); commitFrame(); emit();
  }
  async function replaceSel(file) {
    const f = state.sel; if (!f || !file) return;
    const bytes = new Uint8Array(await file.arrayBuffer());
    const url = URL.createObjectURL(new Blob([bytes], { type: file.type || "image/jpeg" }));
    const im = new Image();
    try {
      await new Promise((res, rej) => { im.onload = res; im.onerror = rej; im.src = url; });
    } catch { URL.revokeObjectURL(url); throw new Error("No se pudo leer esa imagen. Prueba con JPG o PNG."); }
    URL.revokeObjectURL(url);
    const id = "u" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    registerAsset(id, bytes, file.type === "image/png" ? "image/png" : "image/jpeg", im.naturalWidth, im.naturalHeight, true);
    beginFrame(f); applyFrame(f, { ...frameState(f), a: id, z: 1, ox: 0, oy: 0 }); commitFrame(); emit();
  }

  let drag = null;
  desk.addEventListener("pointerdown", (e) => {
    const fe = e.target.closest(".frame");
    if (!fe) { if (!e.target.closest(".line")) select(null); return; }
    const f = fe._f;
    // move keyboard focus off any text line so arrows and shortcuts act on the image
    if (document.activeElement !== fe) fe.focus({ preventScroll: true });
    if (state.sel !== f) { select(f); if (e.pointerType === "touch") return; }
    drag = { f, h: e.target.dataset?.h, sx: e.clientX, sy: e.clientY, start: { x: f.x, y: f.y, w: f.w, h: f.h, ox: f.ox, oy: f.oy }, moved: false };
    fe.setPointerCapture?.(e.pointerId); e.preventDefault();
  });
  window.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const { f, h, start: s } = drag, dx = (e.clientX - drag.sx) / state.scale, dy = (e.clientY - drag.sy) / state.scale;
    if (!drag.moved && Math.hypot(dx, dy) < 1.5) return;
    if (!drag.moved) beginFrame(f);
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
  const endDrag = () => { if (drag) { if (drag.moved) { commitFrame(); emit(); } drag = null; } };
  window.addEventListener("pointercancel", endDrag);
  window.addEventListener("pointerup", endDrag);
  desk.addEventListener("dblclick", (e) => { if (e.target.closest(".frame")) setMode(state.mode === "pan" ? "move" : "pan"); });
  desk.addEventListener("wheel", (e) => {
    const f = state.sel;
    if (!f || !e.target.closest(".frame.sel") || !(e.ctrlKey || e.metaKey || state.mode === "pan")) return;
    e.preventDefault(); frameBurst(f); f.z = Math.max(1, Math.min(4, f.z * (e.deltaY < 0 ? 1.06 : 1 / 1.06))); layoutFrame(f); emit();
  }, { passive: false });
  function nudge(dx, dy) {
    const f = state.sel; if (!f) return false;
    frameBurst(f);
    if (state.mode === "pan") { f.ox += dx; f.oy += dy; } else { f.x += dx; f.y += dy; }
    layoutFrame(f); emit(); return true;
  }

  /* ---------- history ---------- */
  function pushHistory(entry) {
    hist.undo.push(entry); if (hist.undo.length > HISTORY_MAX) hist.undo.shift();
    hist.redo = [];
    edited();
  }
  function applyEntry(entry, side) {
    if (entry.kind === "text") {
      const ln = state.lines.find((x) => x.id === entry.id); if (!ln) return;
      setLine(ln.el, entry[side], true);
      ln.el.scrollIntoView({ block: "nearest", inline: "nearest" });
    } else {
      const f = state.frames.find((x) => x.id === entry.id); if (!f) return;
      applyFrame(f, entry[side]); select(f);
      f.el.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  }
  function undo() {
    commitText(); commitFrame();
    const e = hist.undo.pop(); if (!e) return false;
    applyEntry(e, "before"); hist.redo.push(e); edited(); return true;
  }
  function redo() {
    commitText(); commitFrame();
    const e = hist.redo.pop(); if (!e) return false;
    applyEntry(e, "after"); hist.undo.push(e); edited(); return true;
  }
  const flush = () => { commitText(); commitFrame(); };

  /* ---------- edits (for autosave and project files) ---------- */
  // Only what differs from the converted original: dirty lines, dirty frames, and the user images they use.
  function getEdits() {
    flush();
    const lines = state.lines.filter(({ el }) => isDirtyLine(el)).map(({ id, el }) => ({ id, runs: runsOf(el) }));
    const frames = state.frames.filter(isDirtyFrame).map((f) => ({ id: f.id, ...frameState(f) }));
    const assets = {};
    frames.forEach((f) => { const a = state.assets[f.a]; if (a && a.user) assets[f.a] = { mime: a.mime, w: a.w, h: a.h, bytes: a.bytes }; });
    return { v: 1, lines, frames, assets };
  }
  function applyEdits(ed) {
    if (!ed) return 0;
    for (const [id, a] of Object.entries(ed.assets || {})) if (!state.assets[id]) registerAsset(id, a.bytes, a.mime, a.w, a.h, true);
    let n = 0;
    for (const l of ed.lines || []) { const ln = state.lines.find((x) => x.id === l.id); if (ln) { setLine(ln.el, l.runs); n++; } }
    for (const fr of ed.frames || []) {
      const f = state.frames.find((x) => x.id === fr.id);
      if (f && state.assets[fr.a]) { const { id, ...s } = fr; applyFrame(f, s); n++; }
    }
    hist.undo = []; hist.redo = [];
    emit();
    return n;
  }

  /* ---------- status ---------- */
  function status() {
    const over = desk.querySelectorAll(".line.over").length, dl = desk.querySelectorAll(".line.dirty").length;
    const di = state.frames.filter(isDirtyFrame).length, f = state.sel;
    return {
      scale: state.scale, over, dirtyLines: dl, dirtyFrames: di, mode: state.mode,
      canUndo: hist.undo.length > 0 || !!pendingText || !!pendingFrame, canRedo: hist.redo.length > 0,
      sel: f ? { w: f.w, h: f.h, z: f.z } : null,
    };
  }
  const emit = () => onChange && onChange(status());
  const edited = () => { emit(); onEdit && onEdit(); };

  return {
    load, clear, zoom, fitWidth, setMode, setZoom, resetSel, replaceSel, select, status, geom, runsOf, isDirtyFrame,
    undo, redo, nudge, flush, getEdits, applyEdits,
    get state() { return state; },
  };
}
