"""
Record the README's composer video: the drafting page replaying a recorded session (VITE_AGENT_MODE=replay).

    cd med_app && npm run dev -- --mode replay     # a .env.replay with VITE_AUTH_MODE=mock, VITE_AGENT_MODE=replay, the branding
    python docs/media/scripts/record_composer.py http://localhost:5173 /tmp/rec
    ffmpeg -ss 2.4 -i /tmp/rec/*.webm -vf "scale=1280:-2,fps=24" -c:v libx264 -pix_fmt yuv420p -crf 24 -an docs/media/composer-replay.mp4
    ffmpeg -ss 2.4 -i /tmp/rec/*.webm -vf "fps=8,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle" docs/media/composer-replay.gif

Needs `pip install playwright && playwright install chromium-headless-shell`. Types the recorded session's three turns
(med_app/src/authoring/replay/bp-trend.json) into the chat, waits for each reply, opens the preview, and stops.
"""
import asyncio
import json
import re
import sys
from pathlib import Path

from playwright.async_api import async_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:5173"
OUT = sys.argv[2] if len(sys.argv) > 2 else "/tmp/rec"
SCRIPT = Path(__file__).resolve().parents[3] / "med_app" / "src" / "authoring" / "replay" / "bp-trend.json"


async def main() -> None:
    session = json.loads(SCRIPT.read_text(encoding="utf-8"))
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        context = await browser.new_context(viewport={"width": 1440, "height": 900}, record_video_dir=OUT, record_video_size={"width": 1440, "height": 900})
        page = await context.new_page()
        await page.goto(BASE, wait_until="networkidle")
        await page.wait_for_timeout(600)
        await page.fill("input[autocomplete='username']", "lukas.hoffmann+medapp-authors,medapp-viewers")
        if await page.locator("input[type='password']").count():
            await page.locator("input[type='password']").first.fill("x")
        await page.locator("button[type='submit']").first.click()
        await page.wait_for_timeout(1800)
        await page.get_by_test_id("new-app").click()
        await page.wait_for_timeout(1500)
        box = page.get_by_placeholder(re.compile("Describe the app|answer the question"))
        for i, turn in enumerate(session["turns"]):
            await box.wait_for(state="visible", timeout=15000)
            await box.click()
            await box.type(turn["user"], delay=14)
            await page.wait_for_timeout(400)
            await page.keyboard.press("Enter")
            await page.get_by_test_id("transcript").get_by_text(turn["reply"][:40].split("\n")[0], exact=False).wait_for(timeout=20000)
            await page.wait_for_timeout(2600 if i < 2 else 2200)
        tab = page.get_by_test_id("tab-preview")
        if await tab.count():
            await tab.first.click()
            await page.wait_for_timeout(3500)
        await page.screenshot(path=f"{OUT}/drafting-preview.png")
        await context.close()
        await browser.close()


asyncio.run(main())
