// Font registry. Every PDF font is mapped to a complete, open-licensed family so new characters never
// fall back to an empty glyph. Liberation fonts are metric-compatible with Arial/Helvetica, Times and Courier.
export const FAMILIES = {
  dejavu: { label: "DejaVu Sans", files: ["DejaVuSans.ttf", "DejaVuSans-Bold.ttf"] },
  sans: { label: "Liberation Sans (equivalente métrico de Arial/Helvetica)", files: ["LiberationSans-Regular.ttf", "LiberationSans-Bold.ttf"] },
  serif: { label: "Liberation Serif (equivalente de Times)", files: ["LiberationSerif-Regular.ttf", "LiberationSerif-Bold.ttf"] },
  mono: { label: "Liberation Mono (equivalente de Courier)", files: ["LiberationMono-Regular.ttf", "LiberationMono-Bold.ttf"] },
};

const bytesCache = {};
const base = import.meta.env.BASE_URL + "fonts/";

export const cssFamily = (fam) => `zl-${fam}`;

async function fetchBytes(file) {
  if (!bytesCache[file]) {
    bytesCache[file] = fetch(base + file).then((r) => {
      if (!r.ok) throw new Error("No se pudo cargar la fuente " + file);
      return r.arrayBuffer();
    });
  }
  return bytesCache[file];
}

/** Load the families a document uses into the page (FontFace) */
export async function loadFamilies(fams) {
  await Promise.all(fams.map(async (fam) => {
    const f = FAMILIES[fam] || FAMILIES.sans;
    const [r, b] = await Promise.all(f.files.map(fetchBytes));
    const faces = [new FontFace(cssFamily(fam), r.slice(0), { weight: "400" }), new FontFace(cssFamily(fam), b.slice(0), { weight: "700" })];
    await Promise.all(faces.map((x) => x.load()));
    faces.forEach((x) => document.fonts.add(x));
  }));
}

/** Raw TTF bytes for PDF embedding: [regular, bold] */
export async function fontBytes(fam) {
  const f = FAMILIES[fam] || FAMILIES.sans;
  return Promise.all(f.files.map(async (file) => new Uint8Array(await fetchBytes(file))));
}

/** Fonts the converter found, and which ones are substitutes rather than the same face */
export function substitutions(fontsUsed) {
  return Object.entries(fontsUsed || {})
    .filter(([name, fam]) => !(fam === "dejavu" && /dejavu/i.test(name)) && !/liberation/i.test(name))
    .map(([name, fam]) => ({ name, to: (FAMILIES[fam] || FAMILIES.sans).label }));
}
