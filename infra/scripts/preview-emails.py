#!/usr/bin/env python3
"""
The emails the user pool sends — the invitation and the password-recovery code — rendered to files, so they can be
looked at in a browser (or an email client) before a deploy sends one.

    scripts/preview-emails.py                                   # the hospital file's name and language (HOSPITAL_ID selects it), a sample URL → .build/emails/
    scripts/preview-emails.py --url https://medapp.klinikum-musterstadt.example  # the real panel URL
    scripts/preview-emails.py --language de --out /tmp/emails   # the German texts, elsewhere
    scripts/preview-emails.py --raw                             # Cognito's placeholders left in place instead of sample values

Writes invitation.html and recovery.html, with `{username}` and `{####}` replaced by sample values unless --raw. The
templates themselves live in stacks/email_templates.py; the IdentityStack puts them on the pool at deploy.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(Path(__file__).resolve().parent))  # _hospital: which hospital (HOSPITAL_ID, or the only one configured)

from stacks.email_templates import CODE, USERNAME, invitation_email, parse_language, recovery_email  # noqa: E402
from _hospital import hospital_config  # noqa: E402


def main(argv: list[str] | None = None) -> int:
    try:
        hospital = hospital_config()
    except SystemExit:  # no hospital configured, or several and no HOSPITAL_ID: the preview still works with the flags
        hospital = None
    ap = argparse.ArgumentParser(prog="preview-emails")
    ap.add_argument("--hospital-name", default=hospital.display_name if hospital else "Hospital")
    ap.add_argument("--language", default=(hospital.invitation_language if hospital else None) or "en", help="en | de (the hospital file's invitation_language)")
    ap.add_argument("--url", default=(hospital.panel_url if hospital else None) or "https://d1234abcd.cloudfront.net", help="the panel's URL (the hospital file's panel_url, else the hosting stack's origin at deploy)")
    ap.add_argument("--out", default=str(ROOT / ".build" / "emails"))
    ap.add_argument("--raw", action="store_true", help="keep {username} and {####} instead of sample values")
    args = ap.parse_args(argv)

    language = parse_language(args.language)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    templates = {
        "invitation": invitation_email(hospital_name=args.hospital_name, panel_url=args.url, language=language),
        "recovery": recovery_email(hospital_name=args.hospital_name, panel_url=args.url, language=language),
    }
    for name, t in templates.items():
        html = t.html if args.raw else t.html.replace(USERNAME, "lukas.hoffmann@klinikum-musterstadt.example").replace(CODE, "Kq7#vRt2pL9m" if name == "invitation" else "483921")
        path = out / f"{name}.html"
        path.write_text(html, encoding="utf-8")
        print(f"{path}  ({len(t.html)} chars)  subject: {t.subject}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
