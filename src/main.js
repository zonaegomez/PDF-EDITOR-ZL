import { createEditor } from "./editor.js";
import { loadFamilies, substitutions } from "./fonts.js";
import { keyFor, saveDraft, getDraft, deleteDraft, listDrafts, storageAvailable } from "./store.js";
import { packProject, unpackProject, isProjectFile } from "./project.js";

const $ = (s) => document.querySelector(s);
let toastT;
const toast = (m, ms = 2800) => { const t = $("#toast"); t.textContent = m; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => (t.hidden = true), ms); };

const editor = createEditor({ desk: $("#desk"), onChange: render, onEdit: scheduleSave });
let showEd = false, busy = false;
// the open document: original PDF bytes are kept so drafts and projects can rebuild it later
let doc = null; // { key, fileName, pdf: ArrayBuffer }

/* ---------- home: open a PDF, a project, or a draft ---------- */
const drop = $("#drop");
$("#pdfIn").addEventListener("change", (e) => { const f = e.target.files[0]; e.target.value = ""; if (f) openFile(f); });
drop.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); $("#pdfIn").click(); } });
["dragenter", "dragover"].forEach((t) => document.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add("over"); }));
["dragleave", "drop"].forEach((t) => document.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove("over"); }));
document.addEventListener("drop", (e) => { const f = e.dataTransfer?.files?.[0]; if (f && !$("#home").hidden) openFile(f); });

function setProgress(p, text) { $("#progress").hidden = false; $("#pfill").style.width = Math.round(p * 100) + "%"; $("#ptext").textContent = text; }
function homeError(msg) { $("#progress").hidden = true; const e = $("#homeErr"); e.textContent = msg; e.hidden = false; busy = false; }

async function openFile(file) {
  if (busy) return;
  $("#homeErr").hidden = true;
  if (isProjectFile(file)) {
    try { const p = await unpackProject(file); return openDoc(p.fileName, p.pdf, { edits: p.edits, from: "proyecto" }); }
    catch (err) { return homeError(err.message); }
  }
  if (!/pdf$/i.test(file.type) && !/\.pdf$/i.test(file.name)) return homeError("Ese archivo no es PDF ni proyecto .zlpdf.");
  openDoc(file.name, await file.arrayBuffer(), { checkDraft: true });
}

async function openDoc(fileName, pdf, { edits = null, from = "", checkDraft = false } = {}) {
  busy = true;
  setProgress(0.02, "Cargando motor de PDF…");
  const key = await keyFor(fileName, pdf);
  doc = { key, fileName, pdf };
  let model;
  try { model = await convertInWorker(pdf.slice(0), fileName); }
  catch (err) { return homeError("No se pudo abrir el PDF: " + err.message); }
  try {
    setProgress(0.95, "Cargando fuentes…");
    const fams = [...new Set(model.pages.flatMap((p) => p.lines.flatMap((l) => l.runs.map((r) => r.st.f))))];
    await loadFamilies(fams.length ? fams : ["sans"]);
  } catch (err) { return homeError(String(err.message || err)); }
  $("#home").hidden = true; $("#app").hidden = false; $("#progress").hidden = true;
  editor.load(model);
  notes(model);
  hideResume(); setSaved(null);
  if (edits) {
    const n = editor.applyEdits(edits);
    toast(`Proyecto abierto · ${n} cambios recuperados`);
    scheduleSave();
  } else if (checkDraft && storageAvailable()) {
    const d = await getDraft(key).catch(() => null);
    if (d && (d.edits?.lines?.length || d.edits?.frames?.length)) offerResume(d);
  }
  busy = false;
}

function convertInWorker(bytes, fileName) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
    worker.onmessage = (e) => {
      const m = e.data;
      if (m.type === "progress") setProgress(m.total ? m.done / m.total * 0.9 : 0.05, m.done ? `Separando capas · página ${m.done} de ${m.total}` : "Leyendo PDF…");
      else if (m.type === "error") { worker.terminate(); reject(new Error(m.message)); }
      else if (m.type === "done") { worker.terminate(); resolve(m.model); }
    };
    worker.onerror = (e) => { worker.terminate(); reject(new Error(e.message || "el motor de PDF falló")); };
    worker.postMessage({ bytes, fileName }, [bytes]);
  });
}

/* ---------- recent drafts on the home screen ---------- */
const ago = (t) => {
  const s = (Date.now() - t) / 1000;
  if (s < 60) return "hace un momento"; if (s < 3600) return `hace ${Math.round(s / 60)} min`;
  if (s < 86400) return `hace ${Math.round(s / 3600)} h`;
  return new Date(t).toLocaleDateString("es-MX", { day: "numeric", month: "short" });
};
async function renderRecent() {
  if (!storageAvailable()) return;
  let list = [];
  try { list = (await listDrafts()).filter((d) => d.nLines || d.nFrames); } catch { /* storage blocked: no list */ }
  const ul = $("#recentList"); ul.innerHTML = "";
  $("#recent").hidden = !list.length;
  for (const d of list) {
    const li = document.createElement("li");
    const main = document.createElement("div"); main.className = "r-main";
    const name = document.createElement("span"); name.className = "r-name"; name.textContent = d.fileName;
    const meta = document.createElement("span"); meta.className = "r-meta";
    meta.textContent = `${ago(d.savedAt)} · ${[d.nLines && d.nLines + " textos", d.nFrames && d.nFrames + " imágenes"].filter(Boolean).join(" · ")}`;
    main.append(name, meta);
    const go = document.createElement("button"); go.className = "btn primary"; go.textContent = "Continuar";
    go.onclick = async () => {
      const full = await getDraft(d.key);
      if (full) openDoc(full.fileName, full.pdf, { edits: full.edits });
    };
    const del = document.createElement("button"); del.className = "btn"; del.textContent = "Quitar";
    del.onclick = async () => {
      if (del.dataset.confirm !== "1") { del.dataset.confirm = "1"; del.textContent = "¿Seguro?"; setTimeout(() => { del.dataset.confirm = ""; del.textContent = "Quitar"; }, 3000); return; }
      await deleteDraft(d.key); renderRecent();
    };
    li.append(main, go, del); ul.append(li);
  }
}
renderRecent();

/* ---------- autosave ---------- */
let saveT = null;
function scheduleSave() {
  if (!doc || !storageAvailable()) return;
  clearTimeout(saveT);
  $("#saveChip").hidden = false; $("#saveChip").textContent = "guardando…";
  saveT = setTimeout(saveNow, 1200);
}
async function saveNow() {
  clearTimeout(saveT); saveT = null;
  if (!doc) return false;
  try {
    const edits = editor.getEdits();
    if (!edits.lines.length && !edits.frames.length) { await deleteDraft(doc.key); setSaved("sin cambios guardados"); return true; }
    await saveDraft({ key: doc.key, fileName: doc.fileName, pdf: doc.pdf, edits });
    setSaved("guardado " + new Date().toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit" }));
    return true;
  } catch (err) {
    setSaved("no se pudo guardar");
    toast(/quota/i.test(String(err)) ? "El navegador se quedó sin espacio. Usa “Guardar proyecto”." : "No se pudo guardar en el navegador: " + (err.message || err), 5000);
    return false;
  }
}
function setSaved(text) { const c = $("#saveChip"); c.hidden = !text; c.textContent = text || ""; }

function offerResume(d) {
  const n = (d.edits.lines?.length || 0) + (d.edits.frames?.length || 0);
  $("#resumeText").textContent = `Tienes ${n} cambios guardados de este PDF (${ago(d.savedAt)}).`;
  $("#resume").hidden = false;
  $("#resumeYes").onclick = () => { editor.applyEdits(d.edits); hideResume(); setSaved("cambios recuperados"); toast(`${n} cambios recuperados`); };
  $("#resumeNo").onclick = async () => {
    if ($("#resumeNo").dataset.confirm !== "1") {
      $("#resumeNo").dataset.confirm = "1"; $("#resumeNo").textContent = "¿Borrar los cambios guardados?";
      setTimeout(() => { $("#resumeNo").dataset.confirm = ""; $("#resumeNo").textContent = "Empezar de cero"; }, 3500);
      return;
    }
    await deleteDraft(d.key); hideResume(); toast("Empiezas con el PDF original");
  };
}
function hideResume() { $("#resume").hidden = true; $("#resumeNo").dataset.confirm = ""; $("#resumeNo").textContent = "Empezar de cero"; }

/* ---------- downloads (Vercel: <a download>; inside a Claude artifact: host download) ---------- */
async function download(name, blob) {
  const dl = window.claude?.use ? await window.claude.use("downloads") : null;
  if (dl) {
    try { await dl.save({ filename: name, data: blob }); return true; }
    catch (err) {
      toast(err?.code === "declined" ? "Descarga cancelada." : err?.code === "rejected_extension" ? "Este formato no se puede descargar aquí; usa la app en Vercel." : "No se pudo descargar: " + (err?.message || err), 4500);
      return false;
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a"); a.href = url; a.download = name;
  document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 30000);
  return true;
}
const baseName = () => (doc?.fileName || "documento").replace(/\.(pdf|zlpdf)$/i, "");

async function saveProject() {
  if (!doc) return;
  const blob = packProject({ fileName: doc.fileName, pdf: doc.pdf, edits: editor.getEdits() });
  if (await download(baseName() + ".zlpdf", blob)) toast("Proyecto guardado · ábrelo después desde la pantalla de inicio");
}

async function exportNow() {
  const btn = $("#exportBtn"); if (btn.disabled) return;
  btn.disabled = true; editor.select(null); editor.flush();
  try {
    const { exportPdf } = await import("./export.js");
    const bytes = await exportPdf(editor, (d, t) => (btn.textContent = `Generando ${d}/${t}…`));
    if (await download(baseName() + " (editado).pdf", new Blob([bytes], { type: "application/pdf" }))) toast("PDF listo · " + (bytes.length / 1e6).toFixed(1) + " MB");
  } catch (err) { console.error(err); toast("No se pudo generar el PDF: " + (err.message || err), 5000); }
  finally { btn.disabled = false; btn.textContent = "Exportar PDF"; }
}

/* ---------- fidelity notes shown under the bar ---------- */
function notes(model) {
  const out = [];
  const subs = substitutions(model.fonts);
  if (subs.length) out.push(`Fuentes sustituidas: ${subs.map((s) => s.name).join(", ")} → equivalentes abiertas. Revisa anchos de línea.`);
  const scanned = model.pages.map((p, i) => ({ p, i })).filter(({ p }) => p.lines.length === 0 && p.frames.some((f) => f.w * f.h > p.w * p.h * 0.8));
  if (scanned.length) out.push(`Páginas escaneadas sin texto editable: ${scanned.map((x) => x.i + 1).join(", ")}.`);
  const blank = model.pages.filter((p) => p.lines.length === 0).length;
  if (!scanned.length && blank === model.pages.length) out.push("No se encontró texto: el PDF puede tener el texto convertido a curvas.");
  if (!storageAvailable()) out.push("Este navegador no permite guardar borradores: usa “Guardar proyecto”.");
  const n = $("#notes"); n.hidden = !out.length; n.innerHTML = "";
  out.forEach((t) => { const s = document.createElement("span"); s.textContent = t; n.append(s); });
  $("#docTitle").textContent = model.title; document.title = model.title + " · Editor PDF";
  const nl = model.pages.reduce((a, p) => a + p.lines.length, 0), nf = model.pages.reduce((a, p) => a + p.frames.length, 0);
  $("#stats").textContent = `${model.pages.length} págs · ${nl} líneas · ${nf} imágenes`;
}

/* ---------- toolbar ---------- */
function render(s) {
  $("#zVal").textContent = Math.round(s.scale * 100) + "%";
  $("#overChip").hidden = !s.over;
  $("#overChip").textContent = s.over + (s.over === 1 ? " línea desbordada" : " líneas desbordadas");
  $("#dirtyChip").textContent = s.dirtyLines || s.dirtyFrames
    ? [s.dirtyLines && s.dirtyLines + " textos", s.dirtyFrames && s.dirtyFrames + " imágenes"].filter(Boolean).join(" · ") + " editados"
    : "sin cambios";
  $("#undoBtn").disabled = !s.canUndo; $("#redoBtn").disabled = !s.canRedo;
  $("#ctx").hidden = !s.sel;
  $("#mMove").setAttribute("aria-pressed", s.mode === "move");
  $("#mPan").setAttribute("aria-pressed", s.mode === "pan");
  if (s.sel) {
    $("#dims").textContent = Math.round(s.sel.w) + " × " + Math.round(s.sel.h) + " pt";
    $("#zoomImg").value = Math.round(s.sel.z * 100); $("#zoomImgVal").textContent = Math.round(s.sel.z * 100) + "%";
  }
}
$("#undoBtn").onclick = () => editor.undo();
$("#redoBtn").onclick = () => editor.redo();
$("#zIn").onclick = () => editor.zoom(1.15);
$("#zOut").onclick = () => editor.zoom(1 / 1.15);
$("#zFit").onclick = () => editor.fitWidth();
$("#showEd").onclick = (e) => { showEd = !showEd; document.body.classList.toggle("show", showEd); e.currentTarget.setAttribute("aria-pressed", showEd); };
$("#keysBtn").onclick = (e) => { const k = $("#keys"); k.hidden = !k.hidden; e.currentTarget.setAttribute("aria-expanded", !k.hidden); };
$("#mMove").onclick = () => editor.setMode("move");
$("#mPan").onclick = () => editor.setMode("pan");
$("#zoomImg").oninput = (e) => editor.setZoom(e.target.value / 100);
$("#resetImg").onclick = () => { editor.resetSel(); toast("Imagen restablecida"); };
$("#imgIn").onchange = async (e) => {
  const f = e.target.files[0]; e.target.value = "";
  try { await editor.replaceSel(f); toast("Imagen reemplazada y ajustada al marco"); } catch (err) { toast(err.message); }
};
$("#saveProj").onclick = saveProject;
$("#exportBtn").onclick = exportNow;
$("#newDoc").onclick = async () => {
  editor.flush(); if (saveT) await saveNow(); // never lose the last keystrokes: they are saved before leaving
  editor.clear(); doc = null; hideResume(); setSaved(null);
  $("#app").hidden = true; $("#home").hidden = false; $("#progress").hidden = true;
  document.title = "Editor PDF · Zona Luz";
  renderRecent();
};

/* ---------- keyboard shortcuts ---------- */
window.addEventListener("keydown", (e) => {
  if ($("#app").hidden) return;
  const mod = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
  const inLine = !!e.target.closest?.(".line"), inField = e.target.tagName === "INPUT";
  if (mod && k === "z" && !e.shiftKey) { e.preventDefault(); editor.undo(); return; }
  if (mod && ((k === "z" && e.shiftKey) || k === "y")) { e.preventDefault(); editor.redo(); return; }
  if (mod && k === "s" && e.shiftKey) { e.preventDefault(); saveProject(); return; }
  if (mod && k === "s") { e.preventDefault(); saveNow().then((ok) => ok && toast("Guardado en este navegador")); return; }
  if (mod && k === "e") { e.preventDefault(); exportNow(); return; }
  if (inLine || inField) return;
  if (e.key === "Escape") { editor.select(null); $("#keys").hidden = true; return; }
  const arrow = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
  if (arrow) { const n = e.shiftKey ? 10 : 1; if (editor.nudge(arrow[0] * n, arrow[1] * n)) e.preventDefault(); }
});

// last line of defence: flush pending edits before the tab goes away
const flushAndSave = () => { if (!doc) return; editor.flush(); if (saveT) saveNow(); };
window.addEventListener("pagehide", flushAndSave);
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flushAndSave(); });
let rz; window.addEventListener("resize", () => { clearTimeout(rz); rz = setTimeout(() => editor.state.model && editor.fitWidth(), 200); });
