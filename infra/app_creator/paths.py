"""Where the frontend project (catalog, JSON Schema, compiler CLI) is, from the agent's point of view."""

from __future__ import annotations

import os
from pathlib import Path

INFRA_ROOT = Path(__file__).resolve().parents[1]


def med_app_dir() -> Path:
    """`MEDAPP_APP_DIR` if set (a checkout with node_modules for the CLI), else the sibling `med_app/`."""
    env = os.environ.get("MEDAPP_APP_DIR")
    return Path(env).resolve() if env else (INFRA_ROOT.parent / "med_app").resolve()


def _catalog_dir() -> Path:
    """Packaged copies win (a Lambda has no med_app checkout): `MEDAPP_CATALOG_DIR`, else med_app/docs."""
    env = os.environ.get("MEDAPP_CATALOG_DIR")
    return Path(env).resolve() if env else med_app_dir() / "docs"


def catalog_path() -> Path:
    return _catalog_dir() / "application-catalog.yaml"


def spec_schema_path() -> Path:
    return _catalog_dir() / "app-spec.schema.json"
