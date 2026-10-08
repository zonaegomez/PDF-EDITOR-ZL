import { createEditor } from "./editor.js";
import { loadFamilies, substitutions } from "./fonts.js";

const $ = (s) => document.querySelector(s);
let toastT;
const toast = (m, ms = 2800) => { const t = $("#toast"); t.textContent = m; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => (t.hidden = true), ms); };

const editor = createEditor({ desk: $("#desk"), onChange: render });
let showEd = false, busy = false, fileName = "documento.pdf";

/* ---------- open a PDF ---------- */
const drop = $("#drop");
$("#pdfIn").addEventListener("change", (e) => { const f = e.target.files[0]; e.target.value = ""; if (f) open(f); });
drop.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); $("#pdfIn").click(); } });
["dragenter", "dragover"].forEach((t) => document.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add("over"); }));
["dragleave", "drop"].forEach((t) => document.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove("over"); }));
document.addEventListener("drop", (e) => { const f = e.dataTransfer?.files?.[0]; if (f && !$("#home").hidden) open(f); });

function setProgress(p, text) { $("#progress").hidden = false; $("#pfill").style.width = Math.round(p * 100) + "%"; $("#ptext").textContent = text; }
function homeError(msg) { $("#progress").hidden = true; const e = $("#homeErr"); e.textContent = msg; e.hidden = false; busy = false; }

async function open(file) {
  if (busy) return;
  if (!/pdf$/i.test(file.type) && !/\.pdf$/i.test(file.name)) return homeError("Ese archivo no es PDF.");
  busy = true; fileName = file.name; $("#homeErr").hidden = true;
  setProgress(0.02, "Cargando motor de PDF…");
  const bytes = await file.arrayBuffer();
  const worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
  worker.onmessage = async (e) => {
    const m = e.data;
    if (m.type === "progress") setProgress(m.done / m.total * 0.9, `Separando capas · página ${m.done} de ${m.total}`);
    else if (m.type === "error") { worker.terminate(); homeError("No se pudo abrir el PDF: " + m.message); }
    else if (m.type === "done") {
      worker.terminate();
      try {
        setProgress(0.95, "Cargando fuentes…");
        const fams = [...new Set(m.model.pages.flatMap((p) => p.lines.flatMap((l) => l.runs.map((r) => r.st.f))))];
        await loadFamilies(fams.length ? fams : ["sans"]);
        $("#home").hidden = true; $("#app").hidden = false;
        editor.load(m.model);
        notes(m.model);
        busy = false;
      } catch (err) { homeError(String(err.message || err)); }
    }
  };
  worker.onerror = (e) => { worker.terminate(); homeError("El motor de PDF falló: " + (e.message || "error desconocido")); };
  worker.postMessage({ bytes, fileName: file.name }, [bytes]);
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
  $("#ctx").hidden = !s.sel;
  $("#mMove").setAttribute("aria-pressed", s.mode === "move");
  $("#mPan").setAttribute("aria-pressed", s.mode === "pan");
  if (s.sel) {
    $("#dims").textContent = Math.round(s.sel.w) + " × " + Math.round(s.sel.h) + " pt";
    $("#zoomImg").value = Math.round(s.sel.z * 100); $("#zoomImgVal").textContent = Math.round(s.sel.z * 100) + "%";
  }
}
$("#zIn").onclick = () => editor.zoom(1.15);
$("#zOut").onclick = () => editor.zoom(1 / 1.15);
$("#zFit").onclick = () => editor.fitWidth();
$("#showEd").onclick = (e) => { showEd = !showEd; document.body.classList.toggle("show", showEd); e.currentTarget.setAttribute("aria-pressed", showEd); };
$("#mMove").onclick = () => editor.setMode("move");
$("#mPan").onclick = () => editor.setMode("pan");
$("#zoomImg").oninput = (e) => editor.setZoom(e.target.value / 100);
$("#resetImg").onclick = () => { editor.resetSel(); toast("Imagen restablecida"); };
$("#imgIn").onchange = async (e) => {
  const f = e.target.files[0]; e.target.value = "";
  try { await editor.replaceSel(f); toast("Imagen reemplazada y ajustada al marco"); } catch (err) { toast(err.message); }
};
$("#newDoc").onclick = () => {
  const s = editor.status();
  if ((s.dirtyLines || s.dirtyFrames) && $("#newDoc").dataset.confirm !== "1") {
    $("#newDoc").dataset.confirm = "1"; $("#newDoc").textContent = "¿Descartar cambios?";
    setTimeout(() => { $("#newDoc").dataset.confirm = ""; $("#newDoc").textContent = "Abrir otro"; }, 3500);
    return;
  }
  $("#newDoc").dataset.confirm = ""; $("#newDoc").textContent = "Abrir otro";
  editor.clear(); $("#app").hidden = true; $("#home").hidden = false; $("#progress").hidden = true;
};
window.addEventListener("beforeunload", (e) => { const s = editor.state.model && editor.status(); if (s && (s.dirtyLines || s.dirtyFrames)) { e.preventDefault(); e.returnValue = ""; } });
let rz; window.addEventListener("resize", () => { clearTimeout(rz); rz = setTimeout(() => editor.state.model && editor.fitWidth(), 200); });

$("#exportBtn").onclick = async () => {
  const btn = $("#exportBtn"); btn.disabled = true; editor.select(null);
  try {
    const { exportPdf } = await import("./export.js");
    const bytes = await exportPdf(editor, (d, t) => (btn.textContent = `Generando ${d}/${t}…`));
    const name = fileName.replace(/\.pdf$/i, "") + " (editado).pdf";
    const blob = new Blob([bytes], { type: "application/pdf" });
    // inside a Claude artifact downloads go through the host; on Vercel a normal <a download> works
    const dl = window.claude?.use ? await window.claude.use("downloads") : null;
    if (dl) {
      try { await dl.save({ filename: name, data: blob }); }
      catch (err) { toast(err?.code === "declined" ? "Descarga cancelada." : "No se pudo descargar: " + (err?.message || err), 4000); return; }
    } else {
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a"); a.href = url; a.download = name;
      document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 30000);
    }
    toast("PDF listo · " + (bytes.length / 1e6).toFixed(1) + " MB");
  } catch (err) { console.error(err); toast("No se pudo generar el PDF: " + (err.message || err), 5000); }
  finally { btn.disabled = false; btn.textContent = "Exportar PDF"; }
};
