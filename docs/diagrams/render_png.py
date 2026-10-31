import sys, pathlib
from playwright.sync_api import sync_playwright
svg = pathlib.Path(sys.argv[1]).resolve(); out = sys.argv[2]; scale = float(sys.argv[3]) if len(sys.argv) > 3 else 2
import re
m = re.search(r'width="(\d+)" height="(\d+)"', svg.read_text())
w, h = int(m.group(1)), int(m.group(2))
with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_page(viewport={"width": w, "height": h}, device_scale_factor=scale)
    pg.goto(svg.as_uri())
    pg.wait_for_timeout(300)
    pg.screenshot(path=out, full_page=False)
    b.close()
print("wrote", out)
