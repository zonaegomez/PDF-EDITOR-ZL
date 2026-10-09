// Font registry. Every family is a complete font file we can embed in the exported PDF,
// so new characters never fall back to an empty glyph.
//  - "dejavu/sans/serif/mono": substitutes for fonts found in the PDF (Liberation is metric-compatible
//    with Arial/Helvetica, Times and Courier)
//  - Google Fonts set (SIL OFL): extra choices for formatting
//  - custom: .ttf/.otf files the user uploads (kept in drafts and .zlpdf projects)
export const FAMILIES = {
  dejavu: { label: "DejaVu Sans", files: ["DejaVuSans.ttf", "DejaVuSans-Bold.ttf"] },
  sans: { label: "Arial / Helvetica (Liberation Sans)", files: ["LiberationSans-Regular.ttf", "LiberationSans-Bold.ttf"] },
  serif: { label: "Times (Liberation Serif)", files: ["LiberationSerif-Regular.ttf", "LiberationSerif-Bold.ttf"] },
  mono: { label: "Courier (Liberation Mono)", files: ["LiberationMono-Regular.ttf", "LiberationMono-Bold.ttf"] },
  montserrat: { label: "Montserrat", files: ["Montserrat_400Regular.ttf", "Montserrat_700Bold.ttf"] },
  inter: { label: "Inter", files: ["Inter_400Regular.ttf", "Inter_700Bold.ttf"] },
  poppins: { label: "Poppins", files: ["Poppins_400Regular.ttf", "Poppins_700Bold.ttf"] },
  roboto: { label: "Roboto", files: ["Roboto_400Regular.ttf", "Roboto_700Bold.ttf"] },
  opensans: { label: "Open Sans", files: ["OpenSans_400Regular.ttf", "OpenSans_700Bold.ttf"] },
  lato: { label: "Lato", files: ["Lato_400Regular.ttf", "Lato_700Bold.ttf"] },
  oswald: { label: "Oswald", files: ["Oswald_400Regular.ttf", "Oswald_700Bold.ttf"] },
  playfair: { label: "Playfair Display", files: ["PlayfairDisplay_400Regular.ttf", "PlayfairDisplay_700Bold.ttf"] },
};
export const SUBSTITUTE_FAMILIES = ["dejavu", "sans", "serif", "mono"];
export const EXTRA_FAMILIES = ["montserrat", "inter", "poppins", "roboto", "opensans", "lato", "oswald", "playfair"];

const custom = {};      // id -> { name, reg: Uint8Array, bold: Uint8Array|null }
const bytesCache = {};
const loaded = new Set();
const base = import.meta.env.BASE_URL + "fonts/";

export const cssFamily = (fam) => `zl-${fam}`;
export const isCustom = (fam) => fam.startsWith("c_");
export const customFonts = () => ({ ...custom });
export const familyLabel = (fam) => (custom[fam] ? custom[fam].name + " (tuya)" : (FAMILIES[fam] || FAMILIES.sans).label);

async function fetchBytes(file) {
  if (!bytesCache[file]) {
    bytesCache[file] = fetch(base + file).then((r) => {
      if (!r.ok) throw new Error("No se pudo cargar la fuente " + file);
      return r.arrayBuffer();
    });
  }
  return bytesCache[file];
}

/** Raw font bytes: [regular, bold] (bold falls back to regular for single-file custom fonts) */
export async function fontBytes(fam) {
  if (custom[fam]) return [custom[fam].reg, custom[fam].bold || custom[fam].reg];
  const f = FAMILIES[fam] || FAMILIES.sans;
  return Promise.all(f.files.map(async (file) => new Uint8Array(await fetchBytes(file))));
}

/** Load families into the page (FontFace) so the editor shows and measures them correctly */
export async function loadFamilies(fams) {
  await Promise.all([...new Set(fams)].filter((f) => !loaded.has(f)).map(async (fam) => {
    const [r, b] = await fontBytes(fam);
    const faces = [new FontFace(cssFamily(fam), r.slice(0), { weight: "400" }), new FontFace(cssFamily(fam), b.slice(0), { weight: "700" })];
    await Promise.all(faces.map((x) => x.load()));
    faces.forEach((x) => document.fonts.add(x));
    loaded.add(fam);
  }));
}

const isOpenTypeFont = (u8) => {
  const tag = String.fromCharCode(u8[0], u8[1], u8[2], u8[3]);
  return tag === "OTTO" || tag === "true" || (u8[0] === 0 && u8[1] === 1 && u8[2] === 0 && u8[3] === 0);
};
/** CFF-flavoured OpenType fonts are embedded whole: pdf-lib's subsetter is unreliable with them */
export const canSubset = (u8) => String.fromCharCode(u8[0], u8[1], u8[2], u8[3]) !== "OTTO";

function hashBytes(u8) {
  let h = 2166136261 >>> 0; const step = Math.max(1, Math.floor(u8.length / 8192));
  for (let i = 0; i < u8.length; i += step) { h ^= u8[i]; h = Math.imul(h, 16777619) >>> 0; }
  return (h ^ u8.length).toString(36);
}

/** Register a custom family from already-validated bytes (used when restoring drafts/projects) */
export function registerCustom(id, name, reg, bold) {
  custom[id] = { name, reg, bold: bold || null };
  loaded.delete(id);
  return id;
}

/** Register uploaded .ttf/.otf files as one family. One file = regular; a file named *Bold* becomes the bold. */
export async function addCustomFont(files) {
  const list = [...files];
  if (!list.length) return null;
  const read = await Promise.all(list.map(async (f) => ({ name: f.name, u8: new Uint8Array(await f.arrayBuffer()) })));
  for (const r of read) {
    if (!/\.(ttf|otf)$/i.test(r.name) || !isOpenTypeFont(r.u8)) throw new Error(`“${r.name}” no es una fuente .ttf u .otf válida.`);
  }
  const isBold = (n) => /bold|black|heavy|semibold|demi/i.test(n);
  const reg = read.find((r) => !isBold(r.name)) || read[0];
  const bold = read.find((r) => r !== reg && isBold(r.name)) || null;
  const name = reg.name.replace(/\.(ttf|otf)$/i, "").replace(/[-_ ]?(regular|book|roman|normal|\d00)$/i, "").replace(/[-_]+/g, " ").trim() || "Mi fuente";
  const id = "c_" + hashBytes(reg.u8);
  registerCustom(id, name, reg.u8, bold?.u8);
  await loadFamilies([id]); // fails here if the browser cannot read the font
  return id;
}

/** Fonts the converter found, and which ones are substitutes rather than the same face */
export function substitutions(fontsUsed) {
  return Object.entries(fontsUsed || {})
    .filter(([name, fam]) => !(fam === "dejavu" && /dejavu/i.test(name)) && !/liberation/i.test(name))
    .map(([name, fam]) => ({ name, to: (FAMILIES[fam] || FAMILIES.sans).label }));
}
