"""
The emails the pool sends — invitation and password-recovery code — in the panel's look, with the hospital's name
and the panel's URL baked in; Cognito's placeholders and limits respected; both languages; and the identity stack
carrying them into the pool's message templates.
"""

import re

import aws_cdk as cdk
import pytest
from aws_cdk.assertions import Match, Template

from stacks import IdentityStack
from stacks.email_templates import CODE, MAX_MESSAGE_CHARS, USERNAME, EmailTemplate, invitation_email, parse_language, recovery_email

HOSPITAL = "Klinikum Musterstadt"
URL = "https://d1234abcd.cloudfront.net"


@pytest.mark.parametrize("language", ["en", "de"])
def test_the_invitation_names_the_hospital_links_the_panel_and_keeps_cognitos_placeholders(language):
    t = invitation_email(hospital_name=HOSPITAL, panel_url=URL, language=language, valid_days=3)
    assert HOSPITAL in t.subject and HOSPITAL in t.html
    assert USERNAME in t.html and CODE in t.html, "Cognito fills these; the message is refused without them"
    assert t.html.count(f'href="{URL}"') == 2, "the button and the plain link"
    assert "3" in t.html and ("3 days" in t.html or "3 Tage" in t.html), "the temporary password's validity, from the pool's setting"
    assert len(t.html) < MAX_MESSAGE_CHARS / 2 and "<!DOCTYPE html>" in t.html and f'<html lang="{language}">' in t.html
    # Email HTML: tables and inline styles only — no stylesheet, no script, no image to be blocked.
    assert "<style" not in t.html and "<script" not in t.html and "<img" not in t.html and "<link" not in t.html
    assert "#15202b" in t.html and "#0f6e56" in t.html and "#f4f6f8" in t.html, "the panel's ink, accent and page tokens"
    assert "Medical app builder" in t.html, "the sign-in screen's wordmark"


@pytest.mark.parametrize("language", ["en", "de"])
def test_the_recovery_code_email_has_the_code_but_no_username(language):
    t = recovery_email(hospital_name=HOSPITAL, panel_url=URL, language=language)
    assert CODE in t.html and USERNAME not in t.html
    assert HOSPITAL in t.subject and f'href="{URL}"' in t.html
    assert ("Reset your password" in t.html) if language == "en" else ("Passwort zurücksetzen" in t.html)


def test_what_the_hospital_types_is_escaped_and_a_missing_url_leaves_the_text_standing():
    t = invitation_email(hospital_name="St. Mary's <Children & Youth>", panel_url='https://x.example/?a=1&b="2"')
    assert "St. Mary&#x27;s &lt;Children &amp; Youth&gt;" in t.html and 'href="https://x.example/?a=1&amp;b=&quot;2&quot;"' in t.html
    bare = invitation_email(hospital_name=HOSPITAL, panel_url="")
    assert "href=" not in bare.html and USERNAME in bare.html and CODE in bare.html and "Or open" not in bare.html


def test_the_placeholder_and_size_rules_are_checked_at_synth_not_at_deploy():
    with pytest.raises(ValueError, match=r"\{####\}"):
        EmailTemplate(subject="s", html="no code here " + USERNAME).check(needs_username=True)
    with pytest.raises(ValueError, match=r"\{username\}"):
        EmailTemplate(subject="s", html="code " + CODE).check(needs_username=True)
    EmailTemplate(subject="s", html="code " + CODE).check(needs_username=False)
    with pytest.raises(ValueError, match="characters"):
        EmailTemplate(subject="s", html=CODE + USERNAME + "x" * MAX_MESSAGE_CHARS).check(needs_username=True)
    assert parse_language(None) == "en" and parse_language("de") == "de"
    with pytest.raises(ValueError):
        parse_language("fr")


def test_the_pool_sends_these_templates_with_the_panels_url():
    app = cdk.App()
    stack = IdentityStack(app, "IdentityStack", hospital_id="hsp-test", hospital_name=HOSPITAL, panel_url=URL, invitation_language="de", env=cdk.Environment(account="123456789012", region="eu-central-1"))
    template = Template.from_stack(stack)
    pools = template.find_resources("AWS::Cognito::UserPool")
    assert len(pools) == 1
    props = next(iter(pools.values()))["Properties"]
    invite = props["AdminCreateUserConfig"]["InviteMessageTemplate"]
    assert invite["EmailSubject"] == f"Ihr Zugang zu den klinischen Apps – {HOSPITAL}"
    assert USERNAME in invite["EmailMessage"] and CODE in invite["EmailMessage"] and URL in invite["EmailMessage"] and "Jetzt anmelden" in invite["EmailMessage"]
    verification = props["VerificationMessageTemplate"]
    assert verification["DefaultEmailOption"] == "CONFIRM_WITH_CODE"
    assert CODE in verification["EmailMessage"] and USERNAME not in verification["EmailMessage"] and URL in verification["EmailMessage"]
    assert verification["EmailSubject"].startswith("Ihr Code zum Zurücksetzen des Passworts")
    # The password policy's validity is the number the email quotes.
    assert props["Policies"]["PasswordPolicy"]["TemporaryPasswordValidityDays"] == 3 and "3 Tage" in invite["EmailMessage"]
    template.has_resource_properties("AWS::Cognito::UserPool", {"EmailConfiguration": Match.object_like({"EmailSendingAccount": "COGNITO_DEFAULT"})})


def test_a_pool_without_a_panel_url_still_synthesizes():
    app = cdk.App()
    stack = IdentityStack(app, "IdentityStack", hospital_id="hsp-test", env=cdk.Environment(account="123456789012", region="eu-central-1"))
    props = next(iter(Template.from_stack(stack).find_resources("AWS::Cognito::UserPool").values()))["Properties"]
    message = props["AdminCreateUserConfig"]["InviteMessageTemplate"]["EmailMessage"]
    assert "href=" not in message and re.search(r"hsp-test", message), "no link, the hospital id as its name"


def test_a_hospitals_palette_recolours_the_emails_and_the_defaults_are_the_panels():
    """The emails are in the hospital's look: its palette (stacks/hospitals.py) replaces the default tokens; without one, the defaults."""
    from stacks.email_templates import ACCENT, INK, LINE, MUTED, PAGE, SURFACE, EmailPalette
    from stacks.hospitals import DEFAULT_PALETTE

    assert {k: v.lower() for k, v in DEFAULT_PALETTE.items() if k in ("ink", "muted", "page", "surface", "line", "accent")} == {"ink": INK, "muted": MUTED, "page": PAGE, "surface": SURFACE, "line": LINE, "accent": ACCENT}
    blue = {**DEFAULT_PALETTE, "accent": "#1F5FA8", "ink": "#101820"}
    t = invitation_email(hospital_name=HOSPITAL, panel_url=URL, palette=blue)
    assert "#1f5fa8" in t.html and "#101820" in t.html and "#0f6e56" not in t.html and "#15202b" not in t.html
    assert "#f4f6f8" in t.html, "the colours the hospital did not change stay"
    assert recovery_email(hospital_name=HOSPITAL, panel_url=URL, palette=blue).html.count("#1f5fa8") >= 1
    # The header's secondary text follows the neutrals: the shipped value for the shipped palette, a derived one otherwise.
    assert EmailPalette.from_palette(None).brand_muted == "#a9b7c3"
    derived = EmailPalette.from_palette({**DEFAULT_PALETTE, "muted": "#405060", "line": "#D0D8E0"}).brand_muted
    assert re.fullmatch(r"#[0-9a-f]{6}", derived) and derived not in ("#a9b7c3", "#405060", "#d0d8e0")
    app = cdk.App()
    stack = IdentityStack(app, "IdentityStack", hospital_id="hsp-test", hospital_name=HOSPITAL, panel_url=URL, palette=blue, env=cdk.Environment(account="123456789012", region="eu-central-1"))
    props = next(iter(Template.from_stack(stack).find_resources("AWS::Cognito::UserPool").values()))["Properties"]
    assert "#1f5fa8" in props["AdminCreateUserConfig"]["InviteMessageTemplate"]["EmailMessage"]
