"""
Render the draw.io infrastructure diagram to PNG with the official AWS icons — through the diagrams.net viewer in
headless Chromium (Playwright), since the icons are draw.io's shape library, not files in this repository.

    python render_drawio.py aws-infrastructure.drawio aws-infrastructure.png

Needs `pip install playwright pillow && playwright install chromium-headless-shell` and network access to
viewer.diagrams.net. Alternatively open the .drawio in app.diagrams.net and File → Export as → PNG.
"""
import asyncio
import pathlib
import sys
import urllib.parse

from PIL import Image, ImageChops
from playwright.async_api import async_playwright

src = pathlib.Path(sys.argv[1]).read_text(encoding="utf-8")
out = sys.argv[2]
url = "https://viewer.diagrams.net/?lightbox=0&nav=0&toolbar=0&border=60#R" + urllib.parse.quote(src, safe="")


async def main() -> None:
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        page = await browser.new_page(viewport={"width": 2500, "height": 2050}, device_scale_factor=2)
        await page.goto(url, wait_until="networkidle", timeout=60000)
        await page.wait_for_timeout(4000)  # the shape library loads after the page
        await page.screenshot(path=out, full_page=True)
        await browser.close()
    image = Image.open(out).convert("RGB")
    bbox = ImageChops.difference(image, Image.new("RGB", image.size, (255, 255, 255))).getbbox()
    if bbox:
        image.crop((max(0, bbox[0] - 40), max(0, bbox[1] - 40), min(image.width, bbox[2] + 40), min(image.height, bbox[3] + 40))).save(out, optimize=True)
    print("wrote", out)


asyncio.run(main())
