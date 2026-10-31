"""
The emails the user pool sends, in the panel's look: the invitation (account created, temporary password) and the
password-recovery code. Cognito renders a fixed template — no variables beyond `{username}` and `{####}` — so the
hospital's name and the panel's URL are baked in at deploy time, which is what the IdentityStack does with these.

Email HTML is not web HTML: tables for layout, every style inline, a system font stack (no web fonts), no images
(Outlook blocks them by default; the brand is typographic, like the sign-in screen's panel), nothing that needs a
stylesheet. Rounded corners and the shadow degrade in Outlook's Word engine and that is fine — the hierarchy is
carried by colour and spacing, not by decoration. The design tokens are the panel's (med_app/src/theme.ts).

Preview: `python scripts/preview-emails.py` writes the rendered files under .build/emails/.
"""

from __future__ import annotations

from dataclasses import dataclass
from html import escape
from typing import Literal, Mapping

Language = Literal["en", "de"]

# The panel's palette (med_app/src/branding.ts; stacks/hospitals.py DEFAULT_PALETTE is the same list) — the emails and
# the panel are one brand, so a hospital's palette override reaches the emails too (`palette=` below).
INK = "#15202b"
MUTED = "#5b6b7a"
PAGE = "#f4f6f8"
SURFACE = "#ffffff"
LINE = "#e3e9ee"
ACCENT = "#0f6e56"
BRAND_MUTED = "#a9b7c3"  # the sign-in panel's secondary text on ink — derived from `muted` and `line` for another palette


@dataclass(frozen=True)
class EmailPalette:
    """The six colours an email uses, lower-case hex as email HTML likes them."""

    ink: str = INK
    muted: str = MUTED
    page: str = PAGE
    surface: str = SURFACE
    line: str = LINE
    accent: str = ACCENT

    @classmethod
    def from_palette(cls, palette: Mapping[str, str] | None) -> "EmailPalette":
        """From the hospital's palette (stacks/hospitals.py — ten colours; the four the emails do not use are ignored)."""
        if not palette:
            return cls()
        return cls(**{f: str(palette[f]).lower() for f in ("ink", "muted", "page", "surface", "line", "accent") if palette.get(f)})

    @property
    def brand_muted(self) -> str:
        """Secondary text on the dark header: between `muted` and `line`, like the panel's neutral scale."""
        if (self.muted, self.line) == (MUTED, LINE):
            return BRAND_MUTED
        a, b = (int(self.muted[i : i + 2], 16) for i in (1, 3, 5)), (int(self.line[i : i + 2], 16) for i in (1, 3, 5))
        return "#" + "".join(f"{round(x + (y - x) * 0.57):02x}" for x, y in zip(a, b))

FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"
MONO = "'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace"

# Cognito's limits for message templates.
MAX_MESSAGE_CHARS = 20000
MAX_SUBJECT_CHARS = 140

USERNAME = "{username}"
CODE = "{####}"


@dataclass(frozen=True)
class EmailTemplate:
    subject: str
    html: str

    def check(self, *, needs_username: bool) -> None:
        """What Cognito will refuse at deploy time, caught at synth: the placeholders and the size limits."""
        if CODE not in self.html:
            raise ValueError(f"the template must contain {CODE}")
        if needs_username and USERNAME not in self.html:
            raise ValueError(f"the invitation template must contain {USERNAME}")
        if len(self.html) > MAX_MESSAGE_CHARS:
            raise ValueError(f"the template is {len(self.html)} characters; Cognito allows {MAX_MESSAGE_CHARS}")
        if not 1 <= len(self.subject) <= MAX_SUBJECT_CHARS:
            raise ValueError(f"the subject must be 1–{MAX_SUBJECT_CHARS} characters")


@dataclass(frozen=True)
class _Copy:
    subject: str
    title: str
    intro: str
    rows: tuple[tuple[str, str, bool], ...]  # label, value, monospace
    button: str
    or_open: str  # "Or open {url} in your browser." — {url} is replaced with the link
    validity: str
    footer: str
    wordmark: str


def _invitation_copy(language: Language, hospital_name: str, valid_days: int) -> _Copy:
    if language == "de":
        return _Copy(
            subject=f"Ihr Zugang zu den klinischen Apps – {hospital_name}",
            title="Ihr Zugang ist eingerichtet",
            intro=(
                f"Eine Administratorin oder ein Administrator hat für Sie ein Konto für die klinischen Apps von {hospital_name} angelegt. "
                "Melden Sie sich mit den Angaben unten an; beim ersten Anmelden wählen Sie ein eigenes Passwort."
            ),
            rows=(("Benutzername", USERNAME, False), ("Vorläufiges Passwort", CODE, True)),
            button="Jetzt anmelden",
            or_open="Oder öffnen Sie {url} in Ihrem Browser.",
            validity=f"Das vorläufige Passwort gilt {valid_days} Tage. Danach kann Ihnen die Administration eine neue Einladung senden.",
            footer=(
                "Sie haben diese Nachricht nicht erwartet? Dann ignorieren Sie sie; ohne das Passwort oben geschieht nichts. "
                "Der Zugang wird von Ihrem Krankenhaus vergeben – bei Fragen wenden Sie sich an Ihre Administration."
            ),
            wordmark="Medical app builder",
        )
    return _Copy(
        subject=f"Your account for the clinical apps of {hospital_name}",
        title="Your account is ready",
        intro=(
            f"An administrator has created your account for the clinical apps of {hospital_name}. "
            "Sign in with the details below; you will choose a password of your own the first time."
        ),
        rows=(("Username", USERNAME, False), ("Temporary password", CODE, True)),
        button="Sign in",
        or_open="Or open {url} in your browser.",
        validity=f"The temporary password is valid for {valid_days} days. After that, an administrator can send you a new invitation.",
        footer=(
            "If you were not expecting this message, ignore it; nothing happens without the password above. "
            "Access is granted by your hospital — if you have questions, contact your administrator."
        ),
        wordmark="Medical app builder",
    )


def _recovery_copy(language: Language, hospital_name: str) -> _Copy:
    if language == "de":
        return _Copy(
            subject=f"Ihr Code zum Zurücksetzen des Passworts – {hospital_name}",
            title="Passwort zurücksetzen",
            intro=(
                "Sie haben auf der Anmeldeseite ein neues Passwort angefordert. "
                "Geben Sie diesen Code dort ein und wählen Sie Ihr neues Passwort."
            ),
            rows=(("Bestätigungscode", CODE, True),),
            button="Zur Anmeldeseite",
            or_open="Oder öffnen Sie {url} in Ihrem Browser.",
            validity="Der Code gilt eine Stunde.",
            footer=(
                "Sie haben kein neues Passwort angefordert? Dann ignorieren Sie diese Nachricht; Ihr Passwort bleibt, wie es ist. "
                "Bei Fragen wenden Sie sich an Ihre Administration."
            ),
            wordmark="Medical app builder",
        )
    return _Copy(
        subject=f"Your password reset code – {hospital_name}",
        title="Reset your password",
        intro="You asked for a new password on the sign-in page. Enter this code there and choose your new password.",
        rows=(("Verification code", CODE, True),),
        button="Go to the sign-in page",
        or_open="Or open {url} in your browser.",
        validity="The code is valid for one hour.",
        footer=(
            "If you did not ask for a new password, ignore this message; your password stays as it is. "
            "If you have questions, contact your administrator."
        ),
        wordmark="Medical app builder",
    )


def _render(copy: _Copy, hospital_name: str, panel_url: str, language: Language, palette: EmailPalette = EmailPalette()) -> str:
    INK, MUTED, PAGE, SURFACE, LINE, ACCENT, BRAND_MUTED = palette.ink, palette.muted, palette.page, palette.surface, palette.line, palette.accent, palette.brand_muted  # noqa: N806 — the template below reads like the design tokens
    name = escape(hospital_name)
    url = escape(panel_url, quote=True)
    text = f"font-family:{FONT};"
    rows = []
    for i, (label, value, mono) in enumerate(copy.rows):
        last = i == len(copy.rows) - 1
        rule = "" if last else f"border-bottom:1px solid {LINE};"
        value_style = f"font-family:{MONO};font-size:16px;font-weight:600;letter-spacing:0.04em;" if mono else f"{text}font-size:15px;"
        rows.append(
            f'<tr><td style="padding:12px 16px;{rule}{text}font-size:13px;color:{MUTED};width:42%;vertical-align:top;">{escape(label)}</td>'
            f'<td style="padding:12px 16px;{rule}{value_style}line-height:1.4;color:{INK};">{value}</td></tr>'
        )
    link = f'<a href="{url}" style="color:{ACCENT};text-decoration:underline;word-break:break-all;">{url}</a>'
    or_open = escape(copy.or_open).replace("{url}", link)
    # Without a URL (a pool deployed without the hosting stack) there is nothing to link to: the text stands on its own.
    sign_in = (
        [
            '<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0 12px;">',
            f'<tr><td style="background:{ACCENT};border-radius:8px;">',
            f'<a href="{url}" style="display:inline-block;padding:12px 22px;{text}font-size:15px;font-weight:600;line-height:1.2;color:#ffffff;text-decoration:none;">{escape(copy.button)}</a>',
            "</td></tr></table>",
            f'<p style="margin:0 0 16px;{text}font-size:13px;line-height:1.55;color:{MUTED};">{or_open}</p>',
        ]
        if panel_url
        else ['<div style="height:20px;line-height:20px;font-size:20px;">&nbsp;</div>']
    )
    # One line per element: Cognito keeps the template as is, and a compact document stays well under its limit.
    return "\n".join(
        [
            "<!DOCTYPE html>",
            f'<html lang="{language}">',
            "<head>",
            '<meta charset="utf-8">',
            '<meta name="viewport" content="width=device-width, initial-scale=1">',
            '<meta name="color-scheme" content="light">',
            f"<title>{escape(copy.title)}</title>",
            "</head>",
            f'<body style="margin:0;padding:0;background:{PAGE};">',
            f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:{PAGE};">',
            '<tr><td align="center" style="padding:32px 16px;">',
            # Fluid-hybrid: 100% wide up to 560px everywhere, and a fixed 560px table for Outlook, which ignores max-width.
            '<!--[if mso]><table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" align="center"><tr><td><![endif]-->',
            '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;margin:0 auto;">',
            # Brand band — the sign-in screen's panel: the product's name small, the hospital's large, on ink.
            f'<tr><td style="background:{INK};padding:26px 32px 24px;border-radius:12px 12px 0 0;">',
            f'<div style="{text}font-size:13px;font-weight:600;letter-spacing:0.02em;color:{BRAND_MUTED};">{escape(copy.wordmark)}</div>',
            f'<div style="{text}font-size:22px;line-height:1.25;font-weight:600;color:#ffffff;margin-top:4px;">{name}</div>',
            "</td></tr>",
            # The card.
            f'<tr><td style="background:{SURFACE};padding:32px;border:1px solid {LINE};border-top:0;border-radius:0 0 12px 12px;">',
            f'<h1 style="margin:0 0 12px;{text}font-size:20px;line-height:1.3;font-weight:600;color:{INK};">{escape(copy.title)}</h1>',
            f'<p style="margin:0 0 20px;{text}font-size:15px;line-height:1.55;color:{INK};">{escape(copy.intro)}</p>',
            f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid {LINE};border-radius:8px;border-collapse:separate;">',
            *rows,
            "</table>",
            *sign_in,
            f'<p style="margin:0;{text}font-size:13px;line-height:1.55;color:{MUTED};">{escape(copy.validity)}</p>',
            "</td></tr>",
            # Footer, outside the card, quiet.
            f'<tr><td style="padding:16px 8px 0;{text}font-size:12px;line-height:1.5;color:{MUTED};">{escape(copy.footer)}</td></tr>',
            "</table>",
            "<!--[if mso]></td></tr></table><![endif]-->",
            "</td></tr>",
            "</table>",
            "</body>",
            "</html>",
        ]
    )


def invitation_email(*, hospital_name: str, panel_url: str, language: Language = "en", valid_days: int = 3, palette: Mapping[str, str] | None = None) -> EmailTemplate:
    """Account created: who did it, where to sign in, the username and the temporary password, how long it lasts."""
    copy = _invitation_copy(language, hospital_name, valid_days)
    template = EmailTemplate(subject=copy.subject, html=_render(copy, hospital_name, panel_url, language, EmailPalette.from_palette(palette)))
    template.check(needs_username=True)
    return template


def recovery_email(*, hospital_name: str, panel_url: str, language: Language = "en", palette: Mapping[str, str] | None = None) -> EmailTemplate:
    """The password-recovery code the sign-in screen's "Forgot password" asks for (Cognito's verification message, CODE style)."""
    copy = _recovery_copy(language, hospital_name)
    template = EmailTemplate(subject=copy.subject, html=_render(copy, hospital_name, panel_url, language, EmailPalette.from_palette(palette)))
    template.check(needs_username=False)
    return template


def parse_language(value: str | None) -> Language:
    if value in (None, ""):
        return "en"
    if value in ("en", "de"):
        return value  # type: ignore[return-value]
    raise ValueError(f"invitation_language must be 'en' or 'de', not {value!r}")
