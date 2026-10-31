"""
The README's screenshots, from the panel in mock mode (the dev server with the hospital's branding in .env).

    python docs/media/scripts/screenshots.py http://localhost:5173 docs/media

Signs in as an administrator who is also an author and an approver, opens each app for the first synthetic patient,
and captures the launcher, the review page, user management, the audit trail, the catalogue and the shape library.
"""
import asyncio
import os
import sys

from playwright.async_api import async_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:5173"
OUT = sys.argv[2] if len(sys.argv) > 2 else "docs/media"
APPS = [("app_patient_360", "app-patient-360"), ("app_hypertension_register", "app-hypertension-register"), ("app_falls_risk", "app-falls-risk"), ("app_cardio_renal", "app-cardio-renal"), ("app_wound_photos", "app-wound-photos"), ("app_tumour_board", "app-tumour-board"), ("app_ward_worklist", "app-ward-worklist")]
PAGES = [("/apps/app_patient_360/1.0.0/review", "review"), ("/users", "users"), ("/audit", "audit"), ("/catalog", "catalog"), ("/shapes", "shapes")]


async def main() -> None:
    os.makedirs(OUT, exist_ok=True)
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        page = await browser.new_page(viewport={"width": 1440, "height": 900})
        await page.goto(BASE, wait_until="networkidle")
        await page.wait_for_timeout(800)
        await page.screenshot(path=f"{OUT}/sign-in.png")
        await page.fill("input[autocomplete='username']", "ada+medapp-admins,medapp-authors,medapp-approvers")
        if await page.locator("input[type='password']").count():
            await page.locator("input[type='password']").first.fill("x")
        await page.locator("button[type='submit']").first.click()
        await page.wait_for_timeout(2400)
        await page.screenshot(path=f"{OUT}/launcher.png")
        for app, name in APPS:
            await page.goto(f"{BASE}/apps/{app}/1.0.0", wait_until="networkidle")
            await page.wait_for_timeout(1200)
            launch = page.get_by_role("button", name="Open", exact=True)  # single-patient apps ask who to open for
            if await launch.count():
                await launch.first.click()
            await page.wait_for_timeout(4000)
            await page.screenshot(path=f"{OUT}/{name}.png")
            if app == "app_patient_360":
                await page.screenshot(path=f"{OUT}/{name}-full.png", full_page=True)
        for path, name in PAGES:
            await page.goto(BASE + path, wait_until="networkidle")
            await page.wait_for_timeout(2500)
            await page.screenshot(path=f"{OUT}/{name}.png")
        await browser.close()


asyncio.run(main())
