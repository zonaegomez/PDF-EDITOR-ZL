# Undo/redo, autosave + resume, .zlpdf roundtrip and export, against the built app.
import asyncio, sys
from playwright.async_api import async_playwright
PDF, OUT = sys.argv[1], sys.argv[2]; URL = sys.argv[3] if len(sys.argv) > 3 else "http://localhost:4173/"
TITLE = "[...document.querySelectorAll('.line')].find(e=>e.textContent.startsWith('PUENTE SAN JUAN'))"
FRAME = "document.querySelectorAll('.pwrap')[5].querySelectorAll('.frame')[1]._f"
def ok(c, m): print(("PASS " if c else "FAIL ") + m, flush=True)
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(); ctx = await b.new_context(viewport={"width": 1300, "height": 1000}, accept_downloads=True)
        pg = await ctx.new_page(); errs = []
        pg.on("pageerror", lambda e: errs.append(str(e)))
        await ctx.route("**/fonts.googleapis.com/**", lambda r: r.abort())
        await pg.goto(URL, wait_until="domcontentloaded")
        await pg.set_input_files("#pdfIn", PDF); await pg.wait_for_selector("#app:not([hidden])", timeout=120000); await pg.wait_for_timeout(500)
        title = lambda: pg.evaluate(f"{TITLE}.textContent")
        fx = lambda: pg.evaluate(f"{FRAME}.x")
        # --- text typing + undo/redo
        el = await pg.evaluate_handle(TITLE); await el.scroll_into_view_if_needed(); await el.click()
        await pg.keyboard.press("End"); await pg.keyboard.type(" NL", delay=40); await pg.wait_for_timeout(900)
        ok(await title() == "PUENTE SAN JUAN NL", "typing edits the line: " + await title())
        await pg.keyboard.press("Control+z"); await pg.wait_for_timeout(200)
        ok(await title() == "PUENTE SAN JUAN", "Ctrl+Z restores text: " + await title())
        await pg.keyboard.press("Control+Shift+z"); await pg.wait_for_timeout(200)
        ok(await title() == "PUENTE SAN JUAN NL", "Ctrl+Shift+Z redoes text")
        # --- image nudge + undo/redo across kinds
        fr = await pg.evaluate_handle(f"document.querySelectorAll('.pwrap')[5].querySelectorAll('.frame')[1]")
        await fr.scroll_into_view_if_needed(); await fr.click(); x0 = await fx()
        for _ in range(5): await pg.keyboard.press("ArrowRight")
        await pg.wait_for_timeout(900)
        ok(abs(await fx() - x0 - 5) < 0.01, f"arrows move image 5pt ({x0}->{await fx()})")
        await pg.click("#undoBtn"); await pg.wait_for_timeout(200)
        ok(abs(await fx() - x0) < 0.01, "undo button reverts the 5 nudges as one step")
        await pg.keyboard.press("Control+y"); await pg.wait_for_timeout(200)
        ok(abs(await fx() - x0 - 5) < 0.01, "Ctrl+Y redoes the move")
        await pg.fill("#zoomImg", "150"); await pg.dispatch_event("#zoomImg", "input"); await pg.wait_for_timeout(900)
        ok(abs(await pg.evaluate(f"{FRAME}.z") - 1.5) < 0.01, "zoom slider sets 150%")
        await pg.keyboard.press("Control+z"); await pg.wait_for_timeout(200)
        ok(abs(await pg.evaluate(f"{FRAME}.z") - 1) < 0.01 and abs(await fx() - x0 - 5) < 0.01, "undo zoom keeps the move")
        await pg.keyboard.press("Control+z"); await pg.keyboard.press("Control+z"); await pg.wait_for_timeout(200)
        ok(await title() == "PUENTE SAN JUAN" and abs(await fx() - x0) < 0.01, "undo walks back through image and text in order")
        await pg.keyboard.press("Control+y"); await pg.keyboard.press("Control+y"); await pg.keyboard.press("Control+y"); await pg.wait_for_timeout(300)
        ok(await title() == "PUENTE SAN JUAN NL" and abs(await pg.evaluate(f"{FRAME}.z") - 1.5) < 0.01, "redo all three")
        await pg.wait_for_timeout(1800)
        ok("guardado" in await pg.inner_text("#saveChip"), "autosave chip: " + await pg.inner_text("#saveChip"))
        await pg.screenshot(path=f"{OUT}/save_editor.png")
        # --- reload: resume from home list
        await pg.reload(wait_until="domcontentloaded"); await pg.wait_for_selector("#recent:not([hidden])", timeout=10000)
        ok(True, "home shows recent: " + (await pg.inner_text("#recentList")).replace("\n", " | "))
        await pg.screenshot(path=f"{OUT}/save_home.png")
        await pg.click("#recentList .btn.primary"); await pg.wait_for_selector("#app:not([hidden])", timeout=120000); await pg.wait_for_timeout(500)
        ok(await title() == "PUENTE SAN JUAN NL" and abs(await fx() - x0 - 5) < 0.01 and abs(await pg.evaluate(f"{FRAME}.z") - 1.5) < 0.01, "Continuar restores text, move and zoom")
        ok(await pg.is_disabled("#undoBtn"), "history starts clean after resume")
        # --- reopening the same PDF offers recovery
        await pg.click("#newDoc"); await pg.set_input_files("#pdfIn", PDF); await pg.wait_for_selector("#resume:not([hidden])", timeout=120000)
        ok(await title() == "PUENTE SAN JUAN", "reopened PDF starts original: " + await pg.inner_text("#resumeText"))
        await pg.click("#resumeYes"); await pg.wait_for_timeout(300)
        ok(await title() == "PUENTE SAN JUAN NL", "Recuperar cambios applies the draft")
        # --- project file roundtrip
        async with pg.expect_download() as dl: await pg.keyboard.press("Control+Shift+s")
        d = await dl.value; path = f"{OUT}/proyecto.zlpdf"; await d.save_as(path); ok(d.suggested_filename.endswith(".zlpdf"), "project download: " + d.suggested_filename)
        await pg.evaluate("indexedDB.deleteDatabase('zl-pdf-editor')")
        await pg.click("#newDoc"); await pg.set_input_files("#pdfIn", path); await pg.wait_for_selector("#app:not([hidden])", timeout=120000); await pg.wait_for_timeout(500)
        ok(await title() == "PUENTE SAN JUAN NL" and abs(await pg.evaluate(f"{FRAME}.z") - 1.5) < 0.01, "opening .zlpdf restores everything")
        # --- export still works
        async with pg.expect_download(timeout=120000) as dl: await pg.keyboard.press("Control+e")
        d = await dl.value; await d.save_as(f"{OUT}/save_export.pdf"); ok(d.suggested_filename.endswith("(editado).pdf"), "Ctrl+E exports: " + d.suggested_filename)
        ok(not errs, "no page errors " + str(errs[:3]))
        await b.close()
asyncio.run(main())
