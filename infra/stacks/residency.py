"""
Data residency, enforced at synth rather than remembered.

`data_residency` in a hospital's file (infra/hospitals/<id>.json) names the geography every byte of a deployment may be processed in. The only
policy today is `eu`: the deployment region must be an EU member-state region, and the drafting agent's model must
run there too — an `eu.` cross-region inference profile (Bedrock keeps those within its EU geography), a plain model
id invoked in the deployment's own region, or an application inference profile created in an EU region. A `us.` or
`global.` profile is refused: the first runs inference in the United States, the second may route anywhere.

Why a check and not a note: the agent's conversation is free text typed by clinicians, and nothing can guarantee that
a patient detail never gets pasted into it. Where the model runs therefore has to satisfy the requirement on its own,
and a wrong `model_id` in the hospital's file must fail the synth, not a compliance review. The same policy narrows the agent's
Bedrock permissions to the geography (`model_region_pattern`), so a later change of model id cannot quietly reach a
model elsewhere.

What this cannot check: which regions AWS puts in the `eu.` geography (`aws bedrock get-inference-profile` lists them —
confirm with the hospital whether every one of them is acceptable), and the geography behind an application
inference profile ARN (only its own region is visible here).
"""

from __future__ import annotations

# Regions in European Union member states. London (eu-west-2) and Zurich (eu-central-2) carry the `eu-` name but are
# not in the EU; a deployment that may use them should name its own policy rather than widen this one.
EU_REGIONS: tuple[str, ...] = ("eu-central-1", "eu-west-1", "eu-west-3", "eu-north-1", "eu-south-1", "eu-south-2")

# Prefixes of Bedrock cross-region inference profiles, by geography.
GEO_PREFIXES: tuple[str, ...] = ("us.", "eu.", "apac.", "global.", "us-gov.", "jp.", "au.", "ca.")

POLICIES: dict[str, dict[str, object]] = {
    "eu": {"regions": EU_REGIONS, "profile_prefix": "eu.", "model_region_pattern": "eu-*", "name": "the European Union"},
}


class ResidencyError(ValueError):
    """The deployment would process data outside the geography `data_residency` names."""


def policy(data_residency: str | None) -> dict[str, object] | None:
    """The policy for a `data_residency` context value; None when none is set (nothing is enforced)."""
    if not data_residency:
        return None
    key = str(data_residency).strip().lower()
    if key not in POLICIES:
        raise ResidencyError(f"data_residency {data_residency!r} is not a known policy (known: {', '.join(POLICIES)})")
    return POLICIES[key]


def _profile_region(model_id: str) -> str | None:
    """The region of an application inference profile ARN (`arn:aws:bedrock:<region>:<account>:application-inference-profile/<id>`)."""
    parts = model_id.split(":")
    return parts[3] if len(parts) >= 6 and parts[0] == "arn" and parts[2] == "bedrock" else None


def check_model(model_id: str, data_residency: str | None) -> None:
    """Refuse a model id that would run inference outside the geography."""
    rule = policy(data_residency)
    if rule is None:
        return
    prefix = str(rule["profile_prefix"])
    regions = tuple(rule["regions"])  # type: ignore[arg-type]
    arn_region = _profile_region(model_id)
    if arn_region is not None:
        if arn_region not in regions:
            raise ResidencyError(f"model_id {model_id} is an inference profile in {arn_region}, outside {rule['name']} (data_residency={data_residency})")
        return
    geo = next((p for p in GEO_PREFIXES if model_id.startswith(p)), None)
    if geo is not None and geo != prefix:
        where = "any commercial region" if geo == "global." else f"the {geo.rstrip('.')} geography"
        raise ResidencyError(
            f"model_id {model_id} would run inference in {where}; data_residency={data_residency} allows an `{prefix}` cross-region profile "
            f"(e.g. {prefix}{model_id.split('.', 1)[1] if geo else model_id}) or a plain model id invoked in the deployment's own region"
        )


def check_region(region: str | None, data_residency: str | None) -> None:
    """Refuse a deployment region outside the geography (every store and every Lambda lives there)."""
    rule = policy(data_residency)
    if rule is None:
        return
    regions = tuple(rule["regions"])  # type: ignore[arg-type]
    if not region or region not in regions:
        raise ResidencyError(f"region {region or '(unset)'} is outside {rule['name']}; data_residency={data_residency} allows: {', '.join(regions)} (set `region` in the hospital's file or CDK_DEFAULT_REGION)")


def model_region_pattern(data_residency: str | None) -> str:
    """The region wildcard for the agent's Bedrock permissions: `eu-*` under the EU policy, `*` without one."""
    rule = policy(data_residency)
    return str(rule["model_region_pattern"]) if rule is not None else "*"


def enforce(region: str | None, model_id: str, data_residency: str | None) -> None:
    check_region(region, data_residency)
    check_model(model_id, data_residency)
