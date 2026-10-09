// Layered editor: background image + image frames + baseline-anchored editable text lines.
// One history stack covers every change (text, formatting, images, added and deleted items),
// so Ctrl+Z walks back through all of them in order.
import { cssFamily } from "./fonts.js";

const HISTORY_MAX = 300;
const BURST_MS = 700;           // keystrokes / nudges / slider moves closer than this become one undo step
const DEFAULT_TEXT = { b: 0, s: 12, c: "#1f2220", f: "sans" };

const uid = (p) => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const clone = (o) => JSON.parse(JSON.stringify(o));

export function createEditor({ desk, onChange, onEdit }) {
  const state = {
    model: null, scale: 1, sel: null, mode: "move", assets: {}, frames: [], lines: [], pages: [], urls: [],
    text: null,            // the line the text toolbar acts on: { ln, a, b } (a/b = selection offsets)
    placing: null,         // "text" while waiting for a click to drop a new text box
    lastStyle: null,       // style of the last formatted or created text, reused for new boxes
  };
  const hist = { undo: [], redo: [] };
  let pendingLine = null;  // { ln, before, timer }
  let pendingFrame = null; // { f, before, timer }
  const mctx = document.createElement("canvas").getContext("2d");
  const textW = (t, st) => { mctx.font = (st.b ? "700 " : "400 ") + st.s * 10 + "px " + cssFamily(st.f); return mctx.measureText(t).width / 10; };

  /* ================= build ================= */
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
      page._pi = pi;
      const bgUrl = URL.createObjectURL(new Blob([p.bg], { type: "image/png" })); state.urls.push(bgUrl);
      const bg = new Image(); bg.className = "bg"; bg.alt = ""; bg.src = bgUrl; page.append(bg);
      wrap.append(num, page); wrap._page = page; wrap._p = p; desk.append(wrap);
      state.pages.push({ wrap, page, p });
      p.frames.forEach((f, fi) => makeFrame(pi, { id: pi + ":" + fi, x: f.x, y: f.y, w: f.w, h: f.h, a: f.a, z: 1, ox: 0, oy: 0, hid: false }, false));
      p.lines.forEach((l, li) => makeLine(pi, pi + ":" + li, l, false, false));
    });
    // baseline alignment in one batch: insert all markers, read them, then position every line
    const marks = state.lines.map(({ el }) => { const mk = marker(); el.prepend(mk); return mk; });
    const bs = marks.map((mk) => mk.offsetTop);
    marks.forEach((mk) => mk.remove());
    state.lines.forEach((ln, i) => positionLine(ln, bs[i]));
    fitWidth();
    state.lines.forEach(({ el }) => checkLine(el));
    emit();
  }

  const marker = () => { const mk = document.createElement("span"); mk.style.cssText = "display:inline-block;width:0;height:0;vertical-align:baseline"; return mk; };

  function registerAsset(id, bytes, mime, w, h, user) {
    const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
    state.urls.push(url);
    state.assets[id] = { src: url, w, h, mime, bytes, user };
  }

  function clear() {
    clearTimeout(pendingLine?.timer); clearTimeout(pendingFrame?.timer);
    pendingLine = pendingFrame = null; hist.undo = []; hist.redo = [];
    state.urls.forEach((u) => URL.revokeObjectURL(u));
    Object.assign(state, { model: null, sel: null, assets: {}, frames: [], lines: [], pages: [], urls: [], text: null, placing: null });
    desk.classList.remove("placing");
    desk.innerHTML = "";
  }

  /* ================= view zoom ================= */
  function applyScale() {
    state.pages.forEach(({ wrap, page, p }) => {
      wrap.style.width = p.w * state.scale + "px"; wrap.style.height = p.h * state.scale + "px";
      page.style.transform = "scale(" + state.scale + ")";
    });
    emit();
  }
  function fitWidth() {
    if (!state.model) return;
    const avail = desk.clientWidth - 32, W = Math.max(...state.model.pages.map((p) => p.w));
    state.scale = Math.max(0.3, Math.min(1.6, avail / W)); applyScale();
  }
  const zoom = (k) => { state.scale = Math.max(0.3, Math.min(3, state.scale * k)); applyScale(); };

  /** Page under a screen point, in PDF points */
  function pageAt(cx, cy) {
    for (const { page, p } of state.pages) {
      const r = page.getBoundingClientRect();
      if (cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom)
        return { pi: page._pi, x: (cx - r.left) / state.scale, y: (cy - r.top) / state.scale, p };
    }
    return null;
  }
  /** The page closest to the middle of the visible desk, and the visible centre of it in points */
  function currentPage() {
    const d = desk.getBoundingClientRect(), mid = (d.top + d.bottom) / 2;
    let best = null, dist = Infinity;
    for (const { page, p } of state.pages) {
      const r = page.getBoundingClientRect();
      const dd = mid < r.top ? r.top - mid : mid > r.bottom ? mid - r.bottom : 0;
      if (dd < dist) {
        dist = dd;
        const vy = (Math.max(r.top, Math.min(r.bottom, mid)) - r.top) / state.scale;
        best = { pi: page._pi, x: p.w / 2, y: Math.max(40, Math.min(p.h - 40, vy)), p };
      }
    }
    return best;
  }

  /* ================= text lines ================= */
  function fillRuns(el, runs) {
    runs.forEach((r) => {
      const s = document.createElement("span"); s.textContent = r.t;
      s.style.cssText = `font-family:${cssFamily(r.st.f)},sans-serif;font-size:${r.st.s}px;color:${r.st.c};font-weight:${r.st.b ? 700 : 400}`;
      Object.assign(s.dataset, { s: r.st.s, c: r.st.c, b: r.st.b, f: r.st.f }); el.append(s);
    });
  }
  function baseStyle(el, st) {
    el.style.fontFamily = cssFamily(st.f) + ",sans-serif"; el.style.fontSize = st.s + "px"; el.style.color = st.c; el.style.fontWeight = st.b ? 700 : 400;
  }

  function makeLine(pi, id, l, added, place = true) {
    const { page } = state.pages[pi];
    const el = document.createElement("div"); el.className = "line" + (l.j ? " j" : "") + (added ? " added" : "");
    el.contentEditable = "true"; el.spellcheck = true; el.setAttribute("role", "textbox");
    el.setAttribute("aria-label", added ? "Texto agregado" : "Texto editable");
    baseStyle(el, l.runs[0].st);
    fillRuns(el, l.runs);
    if (l.j) el.style.width = l.w + "px";
    el._l = l; el._id = id; el._orig = added ? null : l.runs.map((r) => r.t).join("");
    const ln = { id, page: pi, data: l, el, added, hid: false, handle: null };
    el._ln = ln;
    page.append(el);
    if (added) {
      const h = document.createElement("div"); h.className = "lhandle"; h.title = "Arrastra para mover"; h.setAttribute("aria-hidden", "true");
      h._ln = ln; ln.handle = h; page.append(h);
    }
    state.lines.push(ln);
    if (place) { placeLine(ln); checkLine(el); }
    return ln;
  }

  function positionLine(ln, b) {
    const { el, data: l } = ln;
    el.style.left = l.x + "px"; el.style.top = l.y - b + "px";
    if (l.rot) { el.style.transformOrigin = "0 " + b + "px"; el.style.transform = "rotate(" + l.rot + "deg)"; }
    el._b = b;
    if (ln.handle) Object.assign(ln.handle.style, { left: l.x - 14 + "px", top: l.y - b + "px", height: Math.max(10, el.offsetHeight) + "px" });
  }
  /** Re-measure where the baseline sits inside the line box (it moves when sizes or fonts change) */
  function placeLine(ln) {
    const c = ln.el.cloneNode(true);
    c.removeAttribute("contenteditable");
    Object.assign(c.style, { visibility: "hidden", transform: "none", top: "0px", left: "0px" });
    const mk = marker(); c.prepend(mk);
    ln.el.parentNode.append(c);
    const b = mk.offsetTop; c.remove();
    positionLine(ln, b);
  }
  const sizeSig = (el) => [...el.querySelectorAll("span[data-s]")].map((s) => s.dataset.s + s.dataset.f).join("|");

  function runsOf(el) {
    const base = el._l.runs[0].st, out = [];
    const push = (t, st) => {
      t = t.replace(/ /g, " ").replace(/[\r\n\t]/g, " "); if (!t) return;
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
  const lineState = (ln) => ({ runs: runsOf(ln.el), x: ln.data.x, y: ln.data.y, hid: !!ln.hid });
  const sameLine = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  function applyLine(ln, s) {
    const { el } = ln;
    if (JSON.stringify(runsOf(el)) !== JSON.stringify(s.runs)) { el.innerHTML = ""; fillRuns(el, s.runs); }
    ln.data.x = s.x; ln.data.y = s.y;
    ln.hid = !!s.hid; el.hidden = ln.hid; if (ln.handle) ln.handle.hidden = ln.hid;
    if (ln.hid && state.text?.ln === ln) { state.text = null; el.blur(); }
    placeLine(ln); checkLine(el);
  }
  function checkLine(el) {
    const runs = runsOf(el), l = el._l, txt = runs.map((r) => r.t).join("");
    el.classList.toggle("blank", !txt.trim());
    if (el._ln?.added) { el._sig = sizeSig(el); return; }
    const nat = runs.reduce((a, r) => a + textW(r.t, r.st), 0);
    el.classList.toggle("over", nat > l.w * 1.02 + 1);
    el.classList.toggle("dirty", JSON.stringify(runs) !== JSON.stringify(l.runs.map((r) => ({ t: r.t, st: r.st }))));
    el._sig = sizeSig(el);
  }
  const isDirtyLine = (ln) => ln.added ? !ln.hid : JSON.stringify(runsOf(ln.el)) !== JSON.stringify(ln.data.runs.map((r) => ({ t: r.t, st: r.st })));

  // one undo step per burst of typing / formatting on the same line
  function beginLine(ln) {
    if (pendingLine && pendingLine.ln !== ln) commitLine();
    commitFrame();
    if (!pendingLine) pendingLine = { ln, before: lineState(ln) };
  }
  function burstLine(ln) { beginLine(ln); clearTimeout(pendingLine.timer); pendingLine.timer = setTimeout(commitLine, BURST_MS); }
  function commitLine() {
    if (!pendingLine) return;
    clearTimeout(pendingLine.timer);
    const { ln, before } = pendingLine; pendingLine = null;
    const after = lineState(ln);
    if (!sameLine(before, after)) pushHistory({ kind: "line", id: ln.id, before, after });
  }

  desk.addEventListener("beforeinput", (e) => {
    const el = e.target.closest?.(".line"); if (!el) return;
    if (e.inputType === "historyUndo" || e.inputType === "historyRedo") { e.preventDefault(); e.inputType === "historyUndo" ? undo() : redo(); return; }
    if (e.inputType === "formatBold") { e.preventDefault(); toggleBold(); return; }
    if (e.inputType.startsWith("format")) { e.preventDefault(); return; } // no native italics/underline: they would not export
    beginLine(el._ln);
  });
  desk.addEventListener("input", (e) => {
    const el = e.target.closest?.(".line"); if (!el) return;
    const prev = el._sig;
    checkLine(el);
    if (el._sig !== prev || el._ln.added) placeLine(el._ln);
    burstLine(el._ln); emit();
  });
  desk.addEventListener("focusin", (e) => {
    const el = e.target.closest?.(".line"); if (!el) return;
    if (state.sel) select(null);
    state.text = { ln: el._ln, a: 0, b: 0 };
    emit();
  });
  desk.addEventListener("focusout", (e) => {
    const el = e.target.closest?.(".line"); if (!el) return;
    commitLine();
    // an added box left empty disappears (and if nothing was ever typed, it leaves no trace in history)
    const ln = el._ln;
    if (ln.added && !ln.hid && !runsOf(el).map((r) => r.t).join("").trim()) {
      setTimeout(() => { if (document.activeElement !== el && !ln.hid) removeLine(ln, true); }, 0);
    }
  });
  document.addEventListener("selectionchange", () => {
    const t = state.text; if (!t) return;
    const s = getSelection(); if (!s.rangeCount) return;
    const r = s.getRangeAt(0);
    if (!t.ln.el.contains(r.startContainer)) return;
    [t.a, t.b] = offsetsIn(t.ln.el, r);
    emitSoon();
  });
  desk.addEventListener("keydown", (e) => {
    const t = e.target;
    if (!t.classList?.contains("line") || e.key !== "Enter") return;
    e.preventDefault(); commitLine();
    const ln = t._ln;
    if (ln.added) { newLineBelow(ln); return; }
    const list = state.lines.filter((x) => x.page === ln.page && !x.hid).map((x) => x.el).sort((a, b) => a._l.y - b._l.y || a._l.x - b._l.x);
    const n = list[list.indexOf(t) + 1];
    if (n) { n.focus(); setOffsets(n, 1e9, 1e9); }
  });
  desk.addEventListener("paste", (e) => {
    if (!e.target.closest?.(".line")) return;
    e.preventDefault();
    document.execCommand("insertText", false, (e.clipboardData.getData("text/plain") || "").replace(/\s+/g, " "));
  });

  function offsetsIn(el, range) {
    const pre = document.createRange(); pre.selectNodeContents(el);
    pre.setEnd(range.startContainer, range.startOffset); const a = pre.toString().length;
    pre.setEnd(range.endContainer, range.endOffset); const b = pre.toString().length;
    return [a, b];
  }
  function setOffsets(el, a, b) {
    const pos = (n) => {
      const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT); let left = n, node, last = null;
      while ((node = w.nextNode())) { if (left <= node.textContent.length) return [node, left]; left -= node.textContent.length; last = node; }
      return last ? [last, last.textContent.length] : [el, el.childNodes.length];
    };
    const r = document.createRange(); const [sn, so] = pos(a), [en, eo] = pos(b);
    r.setStart(sn, so); r.setEnd(en, eo);
    const s = getSelection(); s.removeAllRanges(); s.addRange(r);
  }

  /* ---------- formatting ---------- */
  // patch: object of style fields, or a function (style) => style. Applies to the selection, or the whole line when nothing is selected.
  function format(patch, { refocus = true } = {}) {
    const t = state.text; if (!t || t.ln.hid) return false;
    const { ln } = t, el = ln.el;
    const runs = runsOf(el);
    const chars = runs.flatMap((r) => [...r.t].map((c) => ({ c, st: r.st })));
    let a = Math.min(t.a, t.b), b = Math.max(t.a, t.b);
    if (a === b) { a = 0; b = chars.length; }
    const fn = typeof patch === "function" ? patch : (st) => ({ ...st, ...patch });
    // offsets count UTF-16 units; Array.from splits by code point: rebuild the mapping
    let u = 0;
    chars.forEach((ch) => { const len = ch.c.length; if (u >= a && u < b) ch.st = fn({ ...ch.st }); u += len; });
    const out = [];
    for (const ch of chars) {
      const L = out[out.length - 1];
      if (L && JSON.stringify(L.st) === JSON.stringify(ch.st)) L.t += ch.c; else out.push({ t: ch.c, st: ch.st });
    }
    beginLine(ln);
    const focused = document.activeElement === el;
    el.innerHTML = ""; fillRuns(el, out.length ? out : [{ t: "", st: fn({ ...el._l.runs[0].st }) }]);
    if (!out.length && ln.added) { ln.data.runs[0].st = fn({ ...ln.data.runs[0].st }); baseStyle(el, ln.data.runs[0].st); }
    placeLine(ln); checkLine(el);
    if (ln.added) state.lastStyle = { ...(out[0]?.st || el._l.runs[0].st) };
    if (focused || refocus) { if (!focused) el.focus({ preventScroll: true }); setOffsets(el, t.a, t.b); }
    burstLine(ln); emit();
    return true;
  }
  function textStyle() {
    const t = state.text; if (!t || t.ln.hid) return null;
    const runs = runsOf(t.ln.el);
    let a = Math.min(t.a, t.b), b = Math.max(t.a, t.b);
    const total = runs.reduce((n, r) => n + r.t.length, 0);
    if (a === b) { a = 0; b = total; }
    const picked = []; let u = 0;
    for (const r of runs) { const s = u, e = u + r.t.length; if (e > a && s < b) picked.push(r.st); u = e; }
    if (!picked.length) picked.push(runs[0]?.st || t.ln.data.runs[0].st);
    const same = (k) => picked.every((p) => p[k] === picked[0][k]) ? picked[0][k] : null;
    return { f: same("f"), s: same("s"), c: same("c"), b: same("b"), partial: Math.min(t.a, t.b) !== Math.max(t.a, t.b), added: t.ln.added };
  }
  function toggleBold() { const st = textStyle(); if (st) format({ b: st.b === 1 ? 0 : 1 }); }

  /* ---------- added text boxes ---------- */
  function startPlacing() { select(null); state.placing = "text"; desk.classList.add("placing"); emit(); }
  function cancelPlacing() { if (!state.placing) return; state.placing = null; desk.classList.remove("placing"); emit(); }
  // new boxes start with the document's body style (the style with the most characters),
  // or with the last style the user gave an added box
  function defaultStyle() {
    if (state.lastStyle) return { ...state.lastStyle };
    const counts = {};
    state.lines.forEach((ln) => { if (!ln.added) ln.data.runs.forEach((r) => { const k = JSON.stringify(r.st); counts[k] = (counts[k] || 0) + r.t.length; }); });
    const top = Object.entries(counts).sort((x, y) => y[1] - x[1])[0]?.[0];
    return top ? { ...JSON.parse(top) } : { ...DEFAULT_TEXT };
  }
  function addText(pi, x, yTop, text = "Texto", st = defaultStyle()) {
    flush();
    const l = { x, y: yTop + st.s * 0.95, w: Infinity, rot: 0, j: 0, runs: [{ t: text, st }] };
    const ln = makeLine(pi, uid("n"), l, true);
    const after = lineState(ln);
    pushHistory({ kind: "line", id: ln.id, before: { ...after, hid: true }, after, created: true });
    ln.el.focus({ preventScroll: true }); setOffsets(ln.el, 0, text.length);
    state.text = { ln, a: 0, b: text.length };
    state.lastStyle = { ...st };
    emit();
    return ln;
  }
  function newLineBelow(ln) {
    const runs = runsOf(ln.el), st = { ...(runs[runs.length - 1]?.st || ln.data.runs[0].st) };
    const maxS = Math.max(st.s, ...runs.map((r) => r.st.s));
    const l = { x: ln.data.x, y: ln.data.y + maxS * 1.3, w: Infinity, rot: 0, j: 0, runs: [{ t: "", st }] };
    const n = makeLine(ln.page, uid("n"), l, true);
    pushHistory({ kind: "line", id: n.id, before: { ...lineState(n), hid: true }, after: lineState(n), created: true });
    n.el.focus({ preventScroll: true }); setOffsets(n.el, 0, 0);
  }
  function removeLine(ln, quiet) {
    flush();
    const last = hist.undo[hist.undo.length - 1];
    const before = lineState(ln);
    applyLine(ln, { ...before, hid: true });
    // box created and left empty without typing: drop the creation step instead of adding a removal
    if (quiet && last && last.kind === "line" && last.id === ln.id && last.created) { hist.undo.pop(); emit(); return; }
    pushHistory({ kind: "line", id: ln.id, before, after: { ...before, hid: true } });
  }
  function deleteTextBox() { const t = state.text; if (t?.ln.added) removeLine(t.ln, false); }

  /* ================= images ================= */
  function makeFrame(pi, s, added) {
    const { page } = state.pages[pi];
    const f = { ...s, page: pi, added, orig: { ...s }, hid: !!s.hid };
    const el = document.createElement("div"); el.className = "frame" + (added ? " added" : ""); el.tabIndex = 0;
    el.setAttribute("role", "img"); el.setAttribute("aria-label", "Imagen editable de la página " + (pi + 1));
    const clip = document.createElement("div"); clip.className = "clip";
    const img = new Image(); img.alt = ""; img.draggable = false; img.src = state.assets[f.a].src; clip.append(img);
    const gw = document.createElement("div"); gw.className = "ghostwrap";
    const g = new Image(); g.className = "ghost"; g.alt = ""; g.src = img.src; gw.append(g);
    el.append(clip, gw);
    ["nw", "ne", "sw", "se"].forEach((k) => { const h = document.createElement("div"); h.className = "h " + k; h.dataset.h = k; h.hidden = true; el.append(h); });
    f.el = el; f.img = img; f.ghost = g; el._f = f; el.hidden = f.hid;
    state.frames.push(f);
    // added images go after existing ones (above them), text always stays on top
    const firstLine = page.querySelector(".line, .lhandle");
    page.insertBefore(el, firstLine);
    layoutFrame(f);
    return f;
  }
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
  const frameState = (f) => ({ x: f.x, y: f.y, w: f.w, h: f.h, a: f.a, z: f.z, ox: f.ox, oy: f.oy, hid: !!f.hid });
  const sameFrame = (a, b) => ["x", "y", "w", "h", "z", "ox", "oy"].every((k) => Math.abs(a[k] - b[k]) < 0.01) && a.a === b.a && !!a.hid === !!b.hid;
  function applyFrame(f, s) {
    const srcChanged = f.a !== s.a;
    Object.assign(f, s); f.hid = !!s.hid;
    if (srcChanged) f.img.src = f.ghost.src = state.assets[f.a].src;
    f.el.hidden = f.hid;
    if (f.hid && state.sel === f) select(null);
    layoutFrame(f);
  }
  const isDirtyFrame = (f) => f.added ? !f.hid : !sameFrame(frameState(f), { ...f.orig, z: 1, ox: 0, oy: 0, hid: false });

  function beginFrame(f) {
    if (pendingFrame && pendingFrame.f !== f) commitFrame();
    commitLine();
    if (!pendingFrame) pendingFrame = { f, before: frameState(f) };
  }
  function commitFrame() {
    if (!pendingFrame) return;
    clearTimeout(pendingFrame.timer);
    const { f, before } = pendingFrame; pendingFrame = null;
    const after = frameState(f);
    if (!sameFrame(before, after)) pushHistory({ kind: "frame", id: f.id, before, after });
  }
  function frameBurst(f) { beginFrame(f); clearTimeout(pendingFrame.timer); pendingFrame.timer = setTimeout(commitFrame, BURST_MS); }

  function select(f) {
    commitFrame();
    if (state.sel) { state.sel.el.classList.remove("sel", "pan"); state.sel.el.querySelectorAll(".h").forEach((h) => (h.hidden = true)); }
    state.sel = f || null;
    if (f) {
      state.text = null;
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
    beginFrame(f); applyFrame(f, { ...f.orig, z: 1, ox: 0, oy: 0, hid: false }); commitFrame(); emit();
  }
  function deleteSel() {
    const f = state.sel; if (!f) return false;
    beginFrame(f); applyFrame(f, { ...frameState(f), hid: true }); commitFrame(); emit();
    return true;
  }

  async function readImage(file) {
    if (!file || !/^image\//.test(file.type)) throw new Error("Ese archivo no es una imagen. Usa JPG, PNG o WebP.");
    let bytes = new Uint8Array(await file.arrayBuffer());
    let mime = file.type === "image/png" ? "image/png" : "image/jpeg";
    const url = URL.createObjectURL(new Blob([bytes], { type: file.type }));
    const im = new Image();
    try { await new Promise((res, rej) => { im.onload = res; im.onerror = rej; im.src = url; }); }
    catch { URL.revokeObjectURL(url); throw new Error("No se pudo leer esa imagen. Prueba con JPG o PNG."); }
    // formats the PDF engine cannot embed directly (WebP, GIF, HEIC…) are converted to PNG once
    if (!/^image\/(png|jpeg)$/.test(file.type)) {
      const c = document.createElement("canvas"); c.width = im.naturalWidth; c.height = im.naturalHeight;
      c.getContext("2d").drawImage(im, 0, 0);
      bytes = new Uint8Array(await (await new Promise((r) => c.toBlob(r, "image/png"))).arrayBuffer()); mime = "image/png";
    }
    URL.revokeObjectURL(url);
    const id = uid("u");
    registerAsset(id, bytes, mime, im.naturalWidth, im.naturalHeight, true);
    return id;
  }
  async function replaceSel(file) {
    const f = state.sel; if (!f || !file) return;
    const id = await readImage(file);
    beginFrame(f); applyFrame(f, { ...frameState(f), a: id, z: 1, ox: 0, oy: 0 }); commitFrame(); emit();
  }
  /** Add an image to a page, centred on (cx, cy) in points; defaults to the page in view */
  async function addImage(file, at = currentPage()) {
    if (!at) return null;
    const id = await readImage(file);
    flush();
    const a = state.assets[id], p = at.p;
    let w = Math.min(p.w * 0.45, a.w * 0.75), h = w * a.h / a.w;          // 0.75 = 96 dpi px → pt
    if (h > p.h * 0.5) { h = p.h * 0.5; w = h * a.w / a.h; }
    const x = Math.max(0, Math.min(p.w - w, at.x - w / 2)), y = Math.max(0, Math.min(p.h - h, at.y - h / 2));
    const f = makeFrame(at.pi, { id: uid("n"), x, y, w, h, a: id, z: 1, ox: 0, oy: 0, hid: false }, true);
    const after = frameState(f);
    pushHistory({ kind: "frame", id: f.id, before: { ...after, hid: true }, after });
    setMode("move"); select(f); f.el.focus({ preventScroll: true });
    f.el.scrollIntoView({ block: "nearest", inline: "nearest" });
    return f;
  }

  /* ================= pointer ================= */
  let drag = null;
  desk.addEventListener("pointerdown", (e) => {
    if (state.placing) {
      const at = pageAt(e.clientX, e.clientY);
      e.preventDefault(); cancelPlacing();
      if (at) addText(at.pi, at.x, at.y);
      return;
    }
    const lh = e.target.closest(".lhandle");
    if (lh) {
      const ln = lh._ln; select(null);
      drag = { kind: "line", ln, sx: e.clientX, sy: e.clientY, start: { x: ln.data.x, y: ln.data.y }, moved: false };
      lh.setPointerCapture?.(e.pointerId); lh.classList.add("dragging"); e.preventDefault();
      return;
    }
    const fe = e.target.closest(".frame");
    if (!fe) { if (!e.target.closest(".line")) { select(null); if (state.text) { state.text = null; emit(); } } return; }
    const f = fe._f;
    if (document.activeElement !== fe) fe.focus({ preventScroll: true });
    if (state.sel !== f) { select(f); if (e.pointerType === "touch") return; }
    drag = { kind: "frame", f, h: e.target.dataset?.h, sx: e.clientX, sy: e.clientY, start: { x: f.x, y: f.y, w: f.w, h: f.h, ox: f.ox, oy: f.oy }, moved: false };
    fe.setPointerCapture?.(e.pointerId); e.preventDefault();
  });
  window.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const dx = (e.clientX - drag.sx) / state.scale, dy = (e.clientY - drag.sy) / state.scale;
    if (!drag.moved && Math.hypot(dx, dy) < 1.5) return;
    if (drag.kind === "line") {
      if (!drag.moved) { flush(); drag.before = lineState(drag.ln); }
      drag.moved = true;
      drag.ln.data.x = drag.start.x + dx; drag.ln.data.y = drag.start.y + dy; positionLine(drag.ln, drag.ln.el._b);
      return;
    }
    const { f, h, start: s } = drag;
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
  const endDrag = () => {
    if (!drag) return;
    if (drag.kind === "line") {
      drag.ln.handle?.classList.remove("dragging");
      if (drag.moved) { const after = lineState(drag.ln); if (!sameLine(drag.before, after)) pushHistory({ kind: "line", id: drag.ln.id, before: drag.before, after }); }
    } else if (drag.moved) { commitFrame(); emit(); }
    drag = null;
  };
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

  /* ================= history ================= */
  function pushHistory(entry) {
    hist.undo.push(entry); if (hist.undo.length > HISTORY_MAX) hist.undo.shift();
    hist.redo = [];
    edited();
  }
  function applyEntry(entry, side) {
    const s = entry[side];
    if (entry.kind === "line") {
      const ln = state.lines.find((x) => x.id === entry.id); if (!ln) return;
      applyLine(ln, s);
      if (!s.hid) { ln.el.focus({ preventScroll: true }); setOffsets(ln.el, 1e9, 1e9); ln.el.scrollIntoView({ block: "nearest", inline: "nearest" }); }
    } else {
      const f = state.frames.find((x) => x.id === entry.id); if (!f) return;
      applyFrame(f, s);
      if (!s.hid) { select(f); f.el.scrollIntoView({ block: "nearest", inline: "nearest" }); }
    }
  }
  function undo() {
    flush();
    const e = hist.undo.pop(); if (!e) return false;
    applyEntry(e, "before"); hist.redo.push(e); edited(); return true;
  }
  function redo() {
    flush();
    const e = hist.redo.pop(); if (!e) return false;
    applyEntry(e, "after"); hist.undo.push(e); edited(); return true;
  }
  function flush() { commitLine(); commitFrame(); }

  /* ================= edits (autosave + project files) ================= */
  // Only what differs from the converted original, plus everything that was added.
  function getEdits() {
    flush();
    const lines = [];
    for (const ln of state.lines) {
      if (ln.added) { if (!ln.hid) lines.push({ id: ln.id, page: ln.page, added: 1, x: ln.data.x, y: ln.data.y, runs: runsOf(ln.el) }); }
      else if (isDirtyLine(ln)) lines.push({ id: ln.id, runs: runsOf(ln.el) });
    }
    const frames = [];
    for (const f of state.frames) {
      if (f.added) { if (!f.hid) frames.push({ id: f.id, page: f.page, added: 1, ...frameState(f) }); }
      else if (isDirtyFrame(f)) frames.push({ id: f.id, ...frameState(f) });
    }
    const assets = {};
    frames.forEach((f) => { const a = state.assets[f.a]; if (a && a.user) assets[f.a] = { mime: a.mime, w: a.w, h: a.h, bytes: a.bytes }; });
    const families = [...new Set(lines.flatMap((l) => l.runs.map((r) => r.st.f)))];
    return { v: 2, lines, frames, assets, families };
  }
  function applyEdits(ed) {
    if (!ed) return 0;
    for (const [id, a] of Object.entries(ed.assets || {})) if (!state.assets[id]) registerAsset(id, a.bytes, a.mime, a.w, a.h, true);
    let n = 0;
    for (const l of ed.lines || []) {
      if (l.added) {
        if (!state.pages[l.page] || !l.runs?.length) continue;
        makeLine(l.page, l.id, { x: l.x, y: l.y, w: Infinity, rot: 0, j: 0, runs: clone(l.runs) }, true); n++;
      } else {
        const ln = state.lines.find((x) => x.id === l.id);
        if (ln) { applyLine(ln, { ...lineState(ln), runs: l.runs }); n++; }
      }
    }
    for (const fr of ed.frames || []) {
      if (!state.assets[fr.a]) continue;
      const { id, page, added, ...s } = fr;
      if (added) { if (state.pages[page]) { makeFrame(page, { id, ...s, hid: false }, true); n++; } }
      else { const f = state.frames.find((x) => x.id === id); if (f) { applyFrame(f, s); n++; } }
    }
    hist.undo = []; hist.redo = [];
    emit();
    return n;
  }

  /* ================= status ================= */
  function status() {
    const over = desk.querySelectorAll(".line.over:not([hidden])").length;
    const dl = state.lines.filter(isDirtyLine).length;
    const di = state.frames.filter(isDirtyFrame).length, f = state.sel;
    return {
      scale: state.scale, over, dirtyLines: dl, dirtyFrames: di, mode: state.mode, placing: state.placing,
      canUndo: hist.undo.length > 0 || !!pendingLine || !!pendingFrame, canRedo: hist.redo.length > 0,
      sel: f ? { w: f.w, h: f.h, z: f.z, added: f.added } : null,
      text: textStyle(),
    };
  }
  const emit = () => onChange && onChange(status());
  let emitQueued = false;
  const emitSoon = () => { if (emitQueued) return; emitQueued = true; requestAnimationFrame(() => { emitQueued = false; emit(); }); };
  const edited = () => { emit(); onEdit && onEdit(); };

  return {
    load, clear, zoom, fitWidth, setMode, setZoom, resetSel, replaceSel, deleteSel, select, status, geom, runsOf, isDirtyFrame,
    undo, redo, nudge, flush, getEdits, applyEdits,
    format, textStyle, toggleBold, startPlacing, cancelPlacing, addText, addImage, deleteTextBox, pageAt, currentPage,
    get state() { return state; },
  };
}
