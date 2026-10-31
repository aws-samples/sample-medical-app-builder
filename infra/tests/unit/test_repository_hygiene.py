"""
What the repository must never carry: an AWS account id, an access key, a private key, a real API Gateway or Cognito
host, a real e-mail domain. The sample's hospital, people and endpoints are invented (`*.example` domains, placeholder
hosts, the test account ids CDK's own examples use), and a contribution that pastes a deployment's values into a test,
a document or a hospital file fails here before it reaches a pull request.
"""

from __future__ import annotations

import re
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3]

SKIP_SUFFIXES = (".png", ".jpg", ".jpeg", ".gif", ".mp4", ".webm", ".ico", ".woff", ".woff2", ".ttf", ".pdf", ".zip", ".drawio")
SKIP_FILES = {"med_app/package-lock.json"}
SKIP_DIRS = ("node_modules/", ".venv/", ".build/", "cdk.out/", "dist/", ".eval/", ".sessions/", ".git/")

# Account ids that AWS's and CDK's own documentation use as placeholders.
PLACEHOLDER_ACCOUNTS = {"111111111111", "123456789012", "000000000000", "999999999999"}
# Hosts a document may show as an example.
PLACEHOLDER_HOST_LABELS = {"abc", "xxxxxxxxxx", "example", "api-id", "<api-id>"}


def tracked_files() -> list[Path]:
    """Every file git tracks (the published tree); the working tree's files when there is no git (an archive)."""
    try:
        out = subprocess.run(["git", "ls-files", "-z"], cwd=ROOT, capture_output=True, check=True).stdout
        names = [n for n in out.decode("utf-8").split("\0") if n]
    except (subprocess.CalledProcessError, FileNotFoundError):
        names = [str(p.relative_to(ROOT)) for p in ROOT.rglob("*") if p.is_file() and not any(part in SKIP_DIRS for part in (f"{q}/" for q in p.relative_to(ROOT).parts))]
    return [ROOT / n for n in names if n not in SKIP_FILES and not n.endswith(SKIP_SUFFIXES) and not any(n.startswith(d) or f"/{d}" in n for d in SKIP_DIRS)]


def text_of(path: Path) -> str | None:
    try:
        return path.read_text(encoding="utf-8")
    except (UnicodeDecodeError, OSError):
        return None


RULES: list[tuple[str, re.Pattern[str], callable]] = [
    ("an AWS account id", re.compile(r"(?<![\d.])\d{12}(?![\d.])"), lambda m: m.group(0) not in PLACEHOLDER_ACCOUNTS and not m.group(0).startswith("202")),
    ("an AWS access key id", re.compile(r"\b(AKIA|ASIA)[0-9A-Z]{16}\b"), lambda m: True),
    ("a private key", re.compile(r"-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----"), lambda m: True),
    ("an API Gateway host", re.compile(r"\b([a-z0-9-]+)\.execute-api\.[a-z0-9-]+\.amazonaws\.com"), lambda m: m.group(1) not in PLACEHOLDER_HOST_LABELS),
    ("a Cognito hosted-UI host", re.compile(r"\b([a-z0-9-]+)\.auth\.[a-z0-9-]+\.amazoncognito\.com"), lambda m: True),
    ("a CloudFront host", re.compile(r"\b([a-z0-9]+)\.cloudfront\.net"), lambda m: not re.fullmatch(r"d1234abcd|d[x]+|example", m.group(1))),
    ("an e-mail address outside the example domains", re.compile(r"\b[\w.+-]+@((?:[\w-]+\.)+[a-z]{2,})\b"), lambda m: not EXAMPLE_DOMAIN.fullmatch(m.group(1))),
]

# RFC 2606 / 6761 reserved names, Cognito's default sender, Amazon's own, and the one-letter hosts tests use.
EXAMPLE_DOMAIN = re.compile(r"(?:[\w-]+\.)*(?:example\.(?:org|com|net)|example|invalid|test|localhost)|verificationemail\.com|amazon\.com|amazonaws\.com|[a-z]\.[a-z]{2,3}")


@pytest.mark.parametrize("what,pattern,is_real", RULES, ids=[r[0] for r in RULES])
def test_the_tree_carries_no(what, pattern, is_real):
    hits: list[str] = []
    for path in tracked_files():
        text = text_of(path)
        if text is None:
            continue
        for m in pattern.finditer(text):
            if is_real(m):
                line = text.count("\n", 0, m.start()) + 1
                hits.append(f"{path.relative_to(ROOT)}:{line}: {m.group(0)}")
    assert hits == [], f"{what} in the repository:\n" + "\n".join(hits[:20])


def test_the_shipped_hospital_runs_on_the_reference_servers_and_carries_no_credentials():
    import json

    for file in sorted((ROOT / "infra" / "hospitals").glob("*.json")):
        raw = json.loads(file.read_text(encoding="utf-8"))
        assert "client_id" not in json.dumps(raw) and "client_secret" not in json.dumps(raw), f"{file.name}: credentials belong in Secrets Manager"
        servers = raw.get("hospital_servers")
        if servers:
            for key in ("fhir_base_url", "token_url"):
                assert ".example" in servers[key] or "localhost" in servers[key], f"{file.name}: a shipped hospital file names an example endpoint, not a real one"
