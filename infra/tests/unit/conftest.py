"""Shared fixtures for the whole-app tests: the build steps that run at synth (frontend, bundles, layers, the DICOM seed) stubbed with files, so an app synthesises in seconds and without Node, Docker or ../med_app."""

from __future__ import annotations

import os
from contextlib import contextmanager
from pathlib import Path

import pytest

import stacks.api_stack as api_module
import stacks.authoring_stack as authoring_module
import stacks.hospital_servers_stack as hospital_module
import stacks.hosting_stack as hosting_module
import stacks.reference_servers_stack as reference_module
import stacks.viewer_stack as viewer_module

STAGING_STUBS = {
    authoring_module: ["stage_manifest_service", "stage_agent_layer", "stage_authoring_code", "stage_shared_layer"],
    api_module: ["stage_shared_layer"],
    hospital_module: ["stage_shared_layer"],
    hosting_module: ["stage_frontend"],
    viewer_module: ["stage_ohif"],
    reference_module: ["_stage_shared_layer"],
}


@contextmanager
def stubbed_staging(staged: Path, *, account: str = "111111111111", region: str = "eu-central-1"):
    """Every staging function returns `staged` (a directory with the files the stacks look for); CDK_DEFAULT_* set for the duration."""
    (staged / "index.js").write_text("exports.handler = async () => ({});", encoding="utf-8")
    (staged / "agent_handler.py").write_text("def lambda_handler(e, c): return {}\n", encoding="utf-8")
    (staged / "index.html").write_text("<html></html>", encoding="utf-8")
    (staged / "assets").mkdir(exist_ok=True)
    (staged / "assets" / "app.js").write_text("", encoding="utf-8")
    (staged / "app.bundle.1.js").write_text("", encoding="utf-8")
    originals = [(mod, name, getattr(mod, name)) for mod, names in STAGING_STUBS.items() for name in names]
    originals.append((reference_module, "_stage_dicom_seed", reference_module._stage_dicom_seed))
    env = {k: os.environ.get(k) for k in ("CDK_DEFAULT_ACCOUNT", "CDK_DEFAULT_REGION")}
    os.environ["CDK_DEFAULT_ACCOUNT"] = account
    os.environ["CDK_DEFAULT_REGION"] = region
    for mod, name, _ in originals:
        setattr(mod, name, (lambda s=str(staged): s))
    reference_module._stage_dicom_seed = lambda: (str(staged), "0" * 64, "medapp-seed-test")
    try:
        yield staged
    finally:
        for mod, name, fn in originals:
            setattr(mod, name, fn)
        for k, v in env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v


@pytest.fixture(scope="module")
def staged(tmp_path_factory):
    """The stubbed build steps, for every test of a module that synthesises whole deployments."""
    with stubbed_staging(tmp_path_factory.mktemp("staged")) as path:
        yield path
