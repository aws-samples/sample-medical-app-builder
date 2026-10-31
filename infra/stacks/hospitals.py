"""
The hospitals a checkout deploys — one JSON file per hospital under `infra/hospitals/`, one CDK Stage per file (app.py).

Hospitals differ in configuration, never in code: the same checkout deploys any number of them into one account and
region, each as its own group of stacks named `<hospital_id>-<Stack>` (`hsp-musterstadt-ApiStack`), with every resource
name, SSM path and secret already carrying the hospital id. The files are the configuration that used to sit in
cdk.json's context — same keys, same meaning — so a hospital is added by adding a file, and removed by `cdk destroy`
of its stacks and deleting the file. Nothing secret belongs here: `hospital_servers.credentials_secret` is the *name*
of the Secrets Manager secret, written by scripts/set-hospital-credentials.py.

A hospital's look is configuration too (`branding`): a palette — any subset of the panel's ten colours, the rest
keep the defaults of med_app/src/branding.ts — and a logo whose files sit in `infra/hospitals/<hospital_id>/`. The
HostingStack deploys that folder under `/branding/` and config.json carries the palette and logo to the panel, which
applies them at boot (one build serves every hospital); the user pool's emails take the same palette. The contrast
checks the panel's theme tests run on the default palette run here, at synth, on each hospital's.

    cdk synth                                   # every hospital under infra/hospitals/
    cdk synth -c hospitals=hsp-musterstadt         # one (or a comma-separated few)
    cdk deploy 'hsp-musterstadt/*'                 # that hospital's stacks and no other's
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field, fields
from pathlib import Path
from typing import Any, Mapping, Sequence

HOSPITALS_DIR = Path(__file__).resolve().parents[1] / "hospitals"

# ── branding ──────────────────────────────────────────────────────────────────────────────────────────────────────────
# The panel's palette as shipped (med_app/src/branding.ts — a test keeps the two identical). A hospital overrides any
# subset; the derived shades, the Mantine theme and the CSS variables follow in the browser (med_app/src/theme.ts).
DEFAULT_PALETTE: dict[str, str] = {
    "page": "#F4F6F8",
    "surface": "#FFFFFF",
    "ink": "#15202B",
    "muted": "#5B6B7A",
    "line": "#E3E9EE",
    "accent": "#0F6E56",
    "data": "#1F5FA8",
    "data2": "#7A4DB3",
    "data3": "#B8860B",
    "alert": "#B42318",
}
PALETTE_KEYS = tuple(DEFAULT_PALETTE)
LOGO_KEYS = ("src", "alt", "height", "srcOnDark", "hideName")
HEX = re.compile(r"^#[0-9A-Fa-f]{6}$")
BRANDING_PREFIX = "branding"  # where the HostingStack puts the hospital's files; the panel loads `/branding/<file>`

# The readability a palette must keep (WCAG contrast ratios; the same thresholds as med_app/src/tests/branding.test.tsx).
CONTRAST_RULES: tuple[tuple[str, str, float, str], ...] = (
    ("ink", "page", 7.0, "text on the page"),
    ("ink", "surface", 7.0, "text on cards"),
    ("muted", "surface", 4.5, "secondary text on cards"),
    ("accent", "surface", 4.5, "the accent (buttons, links) on white"),
    ("alert", "surface", 4.5, "alerts on white"),
    ("line", "ink", 7.0, "light text on the sign-in panel's dark ground"),
)

# Lowercase letters, digits and hyphens, 3–15 characters: the id opens every resource name (`medapp-<id>-…`) and the
# longest of them, the reference servers' load balancer `medapp-<id>-reference`, must stay within 32 characters.
ID_PATTERN = re.compile(r"^[a-z][a-z0-9-]{1,13}[a-z0-9]$")

_TRUE = ("1", "true", "yes")


class ConfigError(ValueError):
    """A hospital file that cannot be deployed as written — the message says which file and why."""


@dataclass(frozen=True)
class HospitalConfig:
    """One hospital's deployment settings. Field names are the keys of its JSON file."""

    hospital_id: str                      # in every resource name and SSM path — never changes once deployed
    model_id: str                         # the Bedrock model or inference profile the drafting agent runs on
    hospital_name: str | None = None      # shown in the panel and the pool's emails; the id when unset
    region: str | None = None             # CDK_DEFAULT_REGION, else eu-central-1, when unset
    data_residency: str | None = None     # `eu`: region and model are checked at synth (stacks/residency.py)
    invitation_language: str | None = None  # en | de — the pool's emails
    mfa_required: bool = False
    cognito_domain_prefix: str | None = None  # a hosted-UI domain; globally unique, so one per hospital
    panel_url: str | None = None          # a custom domain for the panel; the hosting stack's origin when unset
    frontend_origins: tuple[str, ...] = ("http://localhost:5173",)  # CORS origins besides the panel's own
    reference_servers: bool = False       # deploy the HAPI + Orthanc stand-ins seeded with the synthetic record
    hospital_servers: Mapping[str, Any] | None = None  # the hospital's FHIR facade and DICOMweb gateway (HospitalServers.from_context validates)
    data_source: str = "bundle"           # without servers: the bundle packaged with the dispatcher, or `fhir` with the two below
    fhir_base_url: str | None = None
    fhir_auth: str | None = None          # bearer | none
    dicomweb_base_url: str | None = None
    ohif_viewer_url: str | None = None    # an external viewer; the ViewerStack otherwise
    app_registry_guard_admin_email: str | None = None      # set → the AppRegistryGuardStack is deployed
    app_registry_guard_allowed_principals: tuple[str, ...] = ()
    branding: Mapping[str, Any] | None = None  # {"palette": {<key>: "#RRGGBB", …}, "logo": {src, alt, height?, srcOnDark?, hideName?}} — validated
    branding_dir: Path | None = field(default=None, compare=False)  # infra/hospitals/<id>/ — the logo files; set by load_hospital

    @classmethod
    def from_mapping(cls, raw: Mapping[str, Any], *, source: str = "<config>") -> "HospitalConfig":
        known = {f.name for f in fields(cls)}
        unknown = sorted(set(raw) - known)
        if unknown:
            raise ConfigError(f"{source}: unknown key(s) {', '.join(unknown)} — the keys are {', '.join(sorted(known))}")
        for key in ("hospital_id", "model_id"):
            if not raw.get(key):
                raise ConfigError(f"{source}: {key} is required")
        hospital_id = str(raw["hospital_id"])
        if not ID_PATTERN.match(hospital_id):
            raise ConfigError(f"{source}: hospital_id {hospital_id!r} must be 3–15 lowercase letters, digits or hyphens, starting with a letter (it opens every resource name)")
        values: dict[str, Any] = {}
        for f in fields(cls):
            if f.name not in raw or raw[f.name] is None:
                continue
            value = raw[f.name]
            if f.name in ("mfa_required", "reference_servers"):
                values[f.name] = value if isinstance(value, bool) else str(value).strip().lower() in _TRUE
            elif f.name in ("frontend_origins", "app_registry_guard_allowed_principals"):
                items = value if isinstance(value, (list, tuple)) else str(value).split(",")
                values[f.name] = tuple(str(v).strip() for v in items if str(v).strip())
            elif f.name == "hospital_servers":
                if not isinstance(value, Mapping):
                    raise ConfigError(f"{source}: hospital_servers must be an object")
                values[f.name] = dict(value)
            elif f.name == "branding":
                values[f.name] = validate_branding(value, source=source)
            elif f.name == "branding_dir":
                values[f.name] = Path(str(value))
            else:
                values[f.name] = str(value)
        return cls(**values)

    @property
    def display_name(self) -> str:
        return self.hospital_name or self.hospital_id

    @property
    def palette(self) -> dict[str, str]:
        """The full palette this hospital's panel and emails use: the defaults, overridden where the file says so."""
        override = (self.branding or {}).get("palette") or {}
        return {**DEFAULT_PALETTE, **{k: str(v).upper() for k, v in override.items()}}

    def frontend_branding(self) -> dict[str, Any] | None:
        """What config.json carries to the panel (`VITE_BRANDING`): the overridden colours and the logo, its files as the
        panel will fetch them (`/branding/<file>`). None when the hospital keeps the defaults."""
        if not self.branding:
            return None
        out: dict[str, Any] = {}
        palette = {k: str(v).upper() for k, v in (self.branding.get("palette") or {}).items()}
        if palette:
            out["palette"] = palette
        logo = self.branding.get("logo")
        if logo:
            out["logo"] = {**logo, **{k: f"/{BRANDING_PREFIX}/{logo[k]}" for k in ("src", "srcOnDark") if logo.get(k)}}
        return out or None

    def logo_files(self) -> tuple[str, ...]:
        logo = (self.branding or {}).get("logo") or {}
        return tuple(str(logo[k]) for k in ("src", "srcOnDark") if logo.get(k))


def validate_branding(raw: object, *, source: str) -> dict[str, Any]:
    """The `branding` block as the panel understands it, or a ConfigError that names the key and the rule it breaks."""
    if not isinstance(raw, Mapping):
        raise ConfigError(f"{source}: branding must be an object with `palette` and/or `logo`")
    unknown = sorted(set(raw) - {"palette", "logo"})
    if unknown:
        raise ConfigError(f"{source}: branding has unknown key(s) {', '.join(unknown)} — it takes `palette` and `logo`")
    out: dict[str, Any] = {}
    palette = raw.get("palette")
    if palette is not None:
        if not isinstance(palette, Mapping):
            raise ConfigError(f"{source}: branding.palette must be an object of colour names to #RRGGBB values")
        bad = sorted(set(palette) - set(PALETTE_KEYS))
        if bad:
            raise ConfigError(f"{source}: branding.palette has unknown colour(s) {', '.join(bad)} — the panel's colours are {', '.join(PALETTE_KEYS)}")
        for key, value in palette.items():
            if not isinstance(value, str) or not HEX.match(value):
                raise ConfigError(f"{source}: branding.palette.{key} must be a #RRGGBB colour, not {value!r}")
        out["palette"] = {k: str(v).upper() for k, v in palette.items()}
        check_contrast({**DEFAULT_PALETTE, **out["palette"]}, source=source)
    logo = raw.get("logo")
    if logo is not None:
        if not isinstance(logo, Mapping):
            raise ConfigError(f"{source}: branding.logo must be an object (src, alt, height, srcOnDark, hideName)")
        bad = sorted(set(logo) - set(LOGO_KEYS))
        if bad:
            raise ConfigError(f"{source}: branding.logo has unknown key(s) {', '.join(bad)} — it takes {', '.join(LOGO_KEYS)}")
        for key in ("src", "alt"):
            if not isinstance(logo.get(key), str) or not logo[key].strip():
                raise ConfigError(f"{source}: branding.logo.{key} is required")
        for key in ("src", "srcOnDark"):
            value = logo.get(key)
            if value is not None and (not isinstance(value, str) or "/" in value or "\\" in value or value.startswith(".")):
                raise ConfigError(f"{source}: branding.logo.{key} must be the name of a file in the hospital's folder (hospitals/<id>/), not a path: {value!r}")
        height = logo.get("height")
        if height is not None and (isinstance(height, bool) or not isinstance(height, int) or not 12 <= height <= 64):
            raise ConfigError(f"{source}: branding.logo.height must be a whole number of pixels between 12 and 64")
        if "hideName" in logo and not isinstance(logo["hideName"], bool):
            raise ConfigError(f"{source}: branding.logo.hideName must be true or false")
        out["logo"] = dict(logo)
    if not out:
        raise ConfigError(f"{source}: branding is empty — leave it out to keep the panel's defaults")
    return out


def _luminance(hex_colour: str) -> float:
    def channel(c: int) -> float:
        s = c / 255
        return s / 12.92 if s <= 0.03928 else ((s + 0.055) / 1.055) ** 2.4

    r, g, b = (int(hex_colour[i : i + 2], 16) for i in (1, 3, 5))
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)


def contrast(a: str, b: str) -> float:
    """WCAG contrast ratio of two #RRGGBB colours."""
    hi, lo = sorted((_luminance(a), _luminance(b)), reverse=True)
    return (hi + 0.05) / (lo + 0.05)


def check_contrast(palette: Mapping[str, str], *, source: str) -> None:
    """A palette that would make the panel unreadable fails the synth, with the ratio it reached and the one it needs."""
    for fg, bg, minimum, what in CONTRAST_RULES:
        ratio = contrast(palette[fg], palette[bg])
        if ratio < minimum:
            raise ConfigError(f"{source}: branding.palette — {what}: {fg} {palette[fg]} on {bg} {palette[bg]} has contrast {ratio:.2f}:1, below {minimum}:1")
    # The neutrals are an order of lightness, text to background; the derived shades assume it.
    lightness = [sum(int(palette[k][i : i + 2], 16) for i in (1, 3, 5)) for k in ("ink", "muted", "line", "page", "surface")]
    if lightness != sorted(lightness):
        raise ConfigError(f"{source}: branding.palette — ink, muted, line, page, surface must go from dark to light, in that order")


def load_hospital(path: Path) -> HospitalConfig:
    """One hospital file; its name must be the hospital id, so the directory listing is the list of deployments."""
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as err:
        raise ConfigError(f"{path}: not valid JSON ({err})") from err
    if not isinstance(raw, Mapping):
        raise ConfigError(f"{path}: the file must hold one JSON object")
    hospital = HospitalConfig.from_mapping(raw, source=str(path))
    if path.stem != hospital.hospital_id:
        raise ConfigError(f"{path}: the file is named {path.stem!r} but its hospital_id is {hospital.hospital_id!r} — they must agree")
    files = hospital.logo_files()
    if files:
        folder = path.parent / hospital.hospital_id
        missing = [f for f in files if not (folder / f).is_file()]
        if missing:
            raise ConfigError(f"{path}: branding.logo names {', '.join(missing)} but the file is not in {folder}/")
        hospital = HospitalConfig(**{**{f.name: getattr(hospital, f.name) for f in fields(hospital)}, "branding_dir": folder})
    return hospital


def load_hospitals(directory: Path = HOSPITALS_DIR, select: str | Sequence[str] | None = None) -> list[HospitalConfig]:
    """Every hospital under `directory`, or the ones `select` names (a comma-separated string or a sequence of ids)."""
    files = sorted(directory.glob("*.json")) if directory.is_dir() else []
    if not files:
        raise ConfigError(f"no hospital is configured: add {directory}/<hospital_id>.json (infra/README.md, 'Adding a hospital')")
    hospitals = {h.hospital_id: h for h in (load_hospital(p) for p in files)}
    if select is None or select == "":
        return list(hospitals.values())
    wanted = [s.strip() for s in (select.split(",") if isinstance(select, str) else select) if s.strip()]
    unknown = [w for w in wanted if w not in hospitals]
    if unknown:
        raise ConfigError(f"no hospital file for {', '.join(unknown)} under {directory} — configured: {', '.join(hospitals)}")
    return [hospitals[w] for w in wanted]


__all__ = ["BRANDING_PREFIX", "DEFAULT_PALETTE", "HOSPITALS_DIR", "ID_PATTERN", "PALETTE_KEYS", "ConfigError", "HospitalConfig", "check_contrast", "contrast", "load_hospital", "load_hospitals", "validate_branding"]
