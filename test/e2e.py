# End-to-end check: open PDF in the built app, compare page renders to the original, edit, export, compare again.
import asyncio, sys, os
from playwright.async_api import async_playwright
PDF = sys.argv[1]; OUT = sys.argv[2]; URL = sys.argv[3] if len(sys.argv) > 3 else "http://localhost:4173/"
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(viewport={"width": 1200, "height": 1300}, accept_downloads=True)
        pg = await ctx.new_page(); errs = []
        pg.on("pageerror", lambda e: errs.append(str(e)))
        pg.on("console", lambda m: m.type == "error" and errs.append(m.text))
        await pg.route("**/fonts.googleapis.com/**", lambda r: r.abort())
        await pg.goto(URL, wait_until="domcontentloaded"); print("loaded", flush=True)
        await pg.screenshot(path=f"{OUT}/home.png")
        t = asyncio.get_event_loop().time()
        await pg.set_input_files("#pdfIn", PDF)
        await pg.wait_for_selector("#app:not([hidden])", timeout=120000)
        print("open+convert s", round(asyncio.get_event_loop().time() - t, 1))
        await pg.wait_for_timeout(800)
        print("bar:", await pg.inner_text("#stats"), "|", await pg.inner_text("#dirtyChip"), "| notes hidden:", await pg.is_hidden("#notes"))
        await pg.screenshot(path=f"{OUT}/editor.png")
        await pg.evaluate("document.querySelectorAll('.pwrap').forEach(w=>{})")
        # 1:1 page shots
        await pg.click("#zFit")
        await pg.evaluate("""()=>{const s=document.querySelector('#zOut');}""")
        n = await pg.evaluate("document.querySelectorAll('.page').length")
        # set scale 1 via zoom buttons is fiddly: screenshot page elements and resize later
        for i in [0, 3, 5]:
            el = (await pg.query_selector_all(".pwrap"))[i]
            await el.scroll_into_view_if_needed(); await el.screenshot(path=f"{OUT}/app{i+1}.png")
        # edits: change title on page 6, replace nothing, zoom photo on page 6
        await pg.evaluate("""()=>{const l=[...document.querySelectorAll('.line')].find(e=>e.textContent.startsWith('PUENTE SAN JUAN'));
            l.lastChild.textContent='PUENTE SAN JUAN · ÑANDÚ'; l.dispatchEvent(new Event('input',{bubbles:true}));}""")
        ph = (await pg.query_selector_all(".pwrap"))[5]
        fr = (await ph.query_selector_all(".frame"))[1]
        await fr.scroll_into_view_if_needed(); await fr.click()
        await pg.fill("#zoomImg", "160"); await pg.dispatch_event("#zoomImg", "input")
        print("after edit:", await pg.inner_text("#dirtyChip"), "| ctx visible:", await pg.is_visible("#ctx"))
        await pg.screenshot(path=f"{OUT}/selected.png")
        async with pg.expect_download(timeout=120000) as dl:
            await pg.click("#exportBtn")
        d = await dl.value; await d.save_as(f"{OUT}/exported.pdf"); print("download:", d.suggested_filename)
        print("errors:", errs[:5])
        await b.close()
asyncio.run(main())
