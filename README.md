# Editor PDF · Zona Luz

Abre un PDF como HTML editable **sin romper el diseño**, cambia textos e imágenes, y expórtalo de nuevo a PDF.
Todo corre en el navegador: el PDF nunca se sube a un servidor.

## Cómo funciona

Cada página se separa en tres capas:

| Capa | Qué es | Qué puedes hacer |
|---|---|---|
| Fondo | La página renderizada **sin texto y sin fotos** (líneas, fondos, tablas dibujadas) | Nada: por eso el diseño no se rompe |
| Imágenes | Cada foto como marco independiente | Reemplazar, mover, redimensionar, zoom y encuadre dentro del marco |
| Texto | Cada línea anclada a su línea base exacta, con su fuente, tamaño, color y justificado | Editar en sitio; las líneas que se pasan del ancho original se marcan en naranja |

### Guardar y deshacer

- **Deshacer / rehacer** (`Ctrl Z`, `Ctrl Shift Z` o `Ctrl Y`): un solo historial para texto e imágenes. Escritura continua, ráfagas de flechas y zoom cuentan como un paso.
- **Autoguardado en el navegador**: cada cambio se guarda en IndexedDB (PDF original + ediciones). Al volver, la pantalla de inicio muestra "Continúa donde te quedaste"; si abres el mismo PDF, ofrece recuperar los cambios. Solo vive en ese navegador y esa compu.
- **Guardar proyecto** (`Ctrl Shift S`): descarga un `.zlpdf` con el PDF original, las ediciones y las imágenes reemplazadas. Se abre desde la pantalla de inicio en cualquier compu y sigues exactamente donde ibas.
- `Ctrl S` guarda en el navegador al momento, `Ctrl E` exporta el PDF. Botón `?` en la barra lista todos los atajos.

Al exportar se arma un PDF real con **pdf-lib**: texto vectorial seleccionable con la fuente embebida, fondo como imagen y fotos recortadas según su encuadre.

```
PDF ──► Web Worker (mupdf.js / WASM) ──► modelo { fondo, marcos, líneas } ──► editor HTML ──► pdf-lib ──► PDF
```

## Estructura

```
src/
  convert.js   extracción por capas con MuPDF (mismo código corre en Node para pruebas)
  worker.js    corre la conversión fuera del hilo principal
  editor.js    texto editable, marcos de imagen, zoom de vista
  export.js    reconstrucción del PDF con pdf-lib + fontkit
  fonts.js     registro de fuentes completas (sin huecos de glifos)
  main.js      pantalla de inicio, barra de herramientas, atajos, autoguardado
  store.js     borradores locales en IndexedDB
  project.js   formato de proyecto .zlpdf
public/fonts/  DejaVu Sans + Liberation Sans/Serif/Mono
test/          conversión en Node y prueba end-to-end en Chromium
```

## Desarrollo

```bash
npm install
npm run dev            # http://localhost:5173
npm run build          # genera dist/
npm run test:convert -- archivo.pdf   # conversión en Node, resumen en consola
```

Prueba end-to-end (requiere Python + Playwright): `npm run build && npx vite preview`, luego
`python3 test/e2e.py archivo.pdf test/` — abre el PDF, edita, exporta y deja capturas en `test/`.
`python3 test/e2e_save.py archivo.pdf test/` — deshacer/rehacer, autoguardado, recuperación y proyecto `.zlpdf`.

## Deploy en Vercel

1. Vercel → **Add New → Project** → importa este repositorio.
2. Framework: **Vite** (se detecta solo; `vercel.json` ya trae build y caché).
3. Deploy. No necesita variables de entorno ni funciones serverless.

El motor WASM pesa ~4.8 MB comprimido; se descarga una vez y queda en caché.

## Límites conocidos

- **PDFs escaneados o con texto en curvas** (exportaciones de Canva/Illustrator): no hay texto que editar. La app lo avisa al abrir. Siguiente paso: OCR.
- **Fuentes**: se sustituyen por equivalentes abiertas (Liberation es métricamente compatible con Arial/Helvetica, Times y Courier). Fuentes de marca distintas se avisan y pueden cambiar anchos de línea. Para fidelidad total, agregar la fuente a `public/fonts/` y a `FAMILIES` en `fonts.js`.
- **Una línea = un elemento**: el texto no se reacomoda entre líneas (eso es lo que protege el diseño).
- **El autoguardado no viaja**: vive en el navegador. Para otra compu o para respaldo, usa "Guardar proyecto". Borrar datos del navegador borra los borradores.
- El historial de deshacer se reinicia al cerrar o reabrir un documento (los cambios sí se conservan).
- Texto justificado se exporta palabra por palabra: se ve idéntico, al copiarlo pueden salir espacios extra.

## Licencias

- **MuPDF / mupdf.js**: AGPL-3.0. Uso interno de Zona Luz sin problema. Si se ofrece como servicio a terceros, hay que publicar el código fuente o adquirir licencia comercial de Artifex.
- pdf-lib y @pdf-lib/fontkit: MIT.
- DejaVu Sans: licencia Bitstream Vera / DejaVu (libre). Liberation: SIL Open Font License 1.1.
