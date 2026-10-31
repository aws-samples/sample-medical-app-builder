"""
The register of accepted cdk-nag findings. app.py runs the AWS Solutions rules (cdk_nag.AwsSolutionsChecks) over every
stack at synth; an error-level finding fails the synth. Everything the platform accepts on purpose is listed here with
its reason — one place a reviewer or the hospital's security team reads instead of grepping ten stack files — and
nothing is accepted without one. Two kinds of acceptance:

  * platform defaults (`accept_platform_defaults`): what the CDK construct library itself produces — the Lambda logging
    managed policy, the `grant_*` helpers' action prefixes on one named bucket/table/function, and the roles of CDK's
    own custom-resource providers (bucket deployments, log retention, the Provider framework). Accepted by shape, with
    anchored patterns, so a new real wildcard (`Resource::*` in our own code) is still flagged.
  * per-stack acceptances (`accept_known_findings`): resources where the rule asks for something the prototype leaves to
    the hospital's operations team before production (access logs, WAF, a Plus-tier user pool), or where it does not apply
    (the reference servers hold the synthetic record only; the default CloudFront certificate fixes the TLS policy).

Re-run `cdk synth` after any infrastructure change: a new finding is a decision to make, here or in the stack.
"""

from __future__ import annotations

from typing import Sequence

import aws_cdk as cdk
from aws_cdk import aws_iam as iam, aws_lambda as lam
from cdk_nag import NagPackSuppression, NagSuppressions, RegexAppliesTo
from constructs import IConstruct

from .api_stack import ApiStack
from .authoring_stack import AuthoringStack
from .hosting_stack import HostingStack
from .hospital_servers_stack import HospitalServersStack
from .identity_stack import IdentityStack
from .reference_servers_stack import ReferenceServersStack
from .viewer_stack import ViewerStack


def accept(construct: IConstruct, rule: str, reason: str, *, applies_to: Sequence[str | RegexAppliesTo] | None = None, children: bool = True) -> None:
    """Accept one rule on a construct (and what it contains), for the reason given — the only way a finding is silenced."""
    NagSuppressions.add_resource_suppressions(construct, [NagPackSuppression(id=rule, reason=reason, applies_to=list(applies_to) if applies_to else None)], apply_to_children=children)


def regex(pattern: str) -> RegexAppliesTo:
    """An `applies_to` entry matching the finding's `Action::…` / `Resource::…` text — anchored, so it names one shape of wildcard."""
    return RegexAppliesTo(regex=f"/{pattern}/g")


# The partition as a finding spells it: the pseudo-parameter, or the literal when `@aws-cdk/core:enablePartitionLiterals`
# (cdk.json) lets a stack with a known region write `aws` / `aws-cn` / `aws-us-gov` outright.
PARTITION = r"(?:<AWS::Partition>|aws(?:-[a-z-]+)?)"

LAMBDA_BASIC_EXECUTION = regex(rf"^Policy::arn:{PARTITION}:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole$")

# One named resource as a finding spells it: the attribute of a resource in the same stack (`<Bucket1234.Arn>`) or, across
# stacks, the output it is imported from — `OtherStack:ExportsOutputFnGetAttBucket1234Arn…` or, with the stack-output
# references `cdk synth` writes, `{"Fn::GetStackOutput":{"StackName":…,"OutputName":…}}`. Never `*`.
NAMED = r'(?:<\w+\.Arn>|[\w-]+:ExportsOutput\w+|\{"Fn::GetStackOutput":\{[^{}]*\}\})'  # stack names carry the hospital id: `hsp-musterstadt-AuthoringStack:ExportsOutput…`

# The wildcards the construct library's grant helpers write — each on one named resource.
GRANT_SHAPES: list[tuple[RegexAppliesTo, str]] = [
    (regex(r"^Action::s3:(GetObject|GetBucket|List|Abort|DeleteObject)\*$"), "s3 grant_read / grant_put / grant_read_write name the object-level actions as prefixes"),
    (regex(rf"^Resource::{NAMED}/\*$"), "every object of the one bucket named by the grant"),
    (regex(rf"^Resource::{NAMED}/index/\*$"), "every index of the one table named by the grant — the registry, drafts and audit tables are queried through their GSIs"),
    (regex(rf"^Resource::{NAMED}:\*$"), "every version and alias of the one function named by grant_invoke"),
    (regex(r"^Action::kms:(ReEncrypt|GenerateDataKey)\*$"), "the table key's grant_encrypt_decrypt names the KMS actions as prefixes"),
]

# CDK's own custom-resource providers, by the ids the library gives them: their roles, policies and runtimes are the
# construct library's, pinned by the aws-cdk-lib version in requirements.txt.
CDK_PROVIDER_IDS = ("Custom::CDKBucketDeployment", "LogRetention", "AWS679f53fac002430cb0da5b7982bd2287", "framework-onEvent", "framework-isComplete", "framework-onTimeout", "waiter-state-machine")


def _is_cdk_provider(construct: IConstruct) -> bool:
    return any(construct.node.id.startswith(prefix) for prefix in CDK_PROVIDER_IDS)


def accept_platform_defaults(stack: cdk.Stack) -> None:
    """What every stack carries because of how the construct library builds it — accepted by shape."""
    for construct in stack.node.find_all():
        if _is_cdk_provider(construct):
            provider = "a custom-resource provider of the CDK construct library (bucket deployment, log retention, the Provider framework): role, policy and runtime are aws-cdk-lib's"
            accept(construct, "AwsSolutions-IAM4", provider)
            accept(construct, "AwsSolutions-IAM5", provider)
            accept(construct, "AwsSolutions-L1", provider)
            continue
        if isinstance(construct, lam.Function):
            accept(construct, "AwsSolutions-IAM4", "AWSLambdaBasicExecutionRole: the function writes its own log group and nothing else; the data permissions are explicit grants", applies_to=[LAMBDA_BASIC_EXECUTION])
        if isinstance(construct, (iam.CfnPolicy, iam.CfnManagedPolicy)):
            for shape, reason in GRANT_SHAPES:
                accept(construct, "AwsSolutions-IAM5", reason, applies_to=[shape], children=False)


def _child(scope: IConstruct, *path: str) -> IConstruct:
    node = scope
    for part in path:
        node = node.node.find_child(part)
    return node


HANDOVER = "left to the hospital's operations team before production — the platform's own audit trail (AuditStack) records every data access, write, account change and lifecycle step"


def accept_known_findings(stack: cdk.Stack) -> None:
    """The per-stack acceptances: each names the resource, the rule and why the prototype leaves it as it is."""
    if isinstance(stack, HostingStack) or isinstance(stack, ViewerStack):
        site = "the panel" if isinstance(stack, HostingStack) else "the imaging viewer"
        accept(stack.bucket, "AwsSolutions-S1", f"server access logs on {site}'s site bucket: a build artefact behind CloudFront with origin access control; {HANDOVER}")
        accept(stack.distribution, "AwsSolutions-CFR3", f"CloudFront access logs for {site}: {HANDOVER}")
        accept(stack.distribution, "AwsSolutions-CFR4", "with the default *.cloudfront.net certificate CloudFront fixes the TLS policy (MinimumProtocolVersion is ignored); TLS 1.2-only comes with the hospital's own domain and ACM certificate")
        accept(stack.distribution, "AwsSolutions-CFR1", "no geo restriction: EU data residency is about where data is processed, not where a signed-in clinician opens the panel")
        accept(stack.distribution, "AwsSolutions-CFR2", f"WAF in front of {site}: a static site behind Cognito sign-in; the hospital's WAF policy applies before production")
    if isinstance(stack, IdentityStack):
        accept(stack.user_pool, "AwsSolutions-COG2", "MFA is a deployment setting (`mfa_required` in the hospital's file under infra/hospitals/, enforced when set); the sample runs without it")
        accept(stack.user_pool, "AwsSolutions-COG8", "the Plus tier (threat protection) is a per-deployment cost decision for the hospital; the prototype runs the Essentials tier")
    if isinstance(stack, ApiStack):
        accept(stack.http_api, "AwsSolutions-APIG1", f"HTTP API access logs: every call is authorised by the Cognito JWT authorizer and audited by the dispatcher itself; infrastructure access logs are {HANDOVER}")
        accept(stack.media_bucket, "AwsSolutions-S1", f"server access logs on the media bucket: objects are reached through presigned URLs the dispatcher issues and audits; {HANDOVER}")
        # With the reference servers as the data source (no hospital_servers) the dispatcher is granted their API's FHIR and
        # DICOMweb routes on any stage and method (SigV4) — the same shape the seed function gets below.
        accept(stack.dispatcher_fn, "AwsSolutions-IAM5", "the dispatcher calls the reference API's FHIR and DICOMweb routes on any stage and method (SigV4); the API and the routes themselves are named", applies_to=[regex(rf"^Resource::arn:{PARTITION}:execute-api:[^:]+:[^:]+:(?:<\w+>|\{{\"Fn::GetStackOutput\":\{{[^{{}}]*\}}\}})/\*/\*/(fhir|dicom-web)(/\*)?$")])
    if isinstance(stack, AuthoringStack):
        accept(stack.vocabulary_bucket, "AwsSolutions-S1", f"server access logs on the record-vocabulary bucket: a derived, code-only artefact read by the drafting agent; {HANDOVER}")
        accept(stack.manifest_fn, "AwsSolutions-L1", "Node.js 22 LTS: the manifest service bundle is built for node22 (scripts/bundle-lambda.mjs); moving the runtime and the bundle target together is a deliberate step")
        accept(stack.agent_fn, "AwsSolutions-IAM5", "the agent may invoke any Bedrock model or inference profile in the EU regions and no other: the region wildcard is the data-residency rule (stacks/residency.py), the model wildcard lets the model id change in the hospital's file without a stack change", applies_to=[regex(r"^Resource::arn:aws:bedrock:eu-\*:")])
        accept(stack.registry_write_fn, "AwsSolutions-IAM5", "at publish the registry writes an app's forms to the record through the data source's seed function, named by convention (medapp-<hospital>-<source>-seed) so the two stacks need not depend on each other", applies_to=[regex(rf"^Resource::arn:{PARTITION}:lambda:[^:]+:[^:]+:function:medapp-.*-\*-seed$")])
    if isinstance(stack, ReferenceServersStack):
        synthetic = "the reference servers hold the synthetic record only (no patient data) and exist for integration tests and previews"
        accept(stack.http_api, "AwsSolutions-APIG1", f"HTTP API access logs: {synthetic}; the FHIR server's own request log is in CloudWatch")
        accept(stack.seed_bucket, "AwsSolutions-S1", f"server access logs on the seed bucket: {synthetic}")
        accept(stack.vpc, "AwsSolutions-VPC7", f"VPC flow logs: {synthetic}; a private VPC with no inbound route from the internet")
        accept(stack.cluster, "AwsSolutions-ECS4", f"Container Insights: {synthetic}; service logs go to CloudWatch, the metrics the tests need are the ALB's")
        accept(_child(stack, "Alb"), "AwsSolutions-ELB2", f"ALB access logs: {synthetic}; the ALB is internal, reached only from the API's VPC link")
        for task in ("HapiTask", "OrthancTask"):
            accept(_child(stack, task), "AwsSolutions-ECS2", "the environment carries the servers' non-secret configuration (datasource URL, FHIR base URL, plugin settings); the database credentials are ECS secrets from Secrets Manager")
        accept(stack.database, "AwsSolutions-RDS3", f"single-AZ: {synthetic}; it is re-seeded from code")
        accept(stack.database, "AwsSolutions-RDS10", f"no deletion protection: {synthetic}; the stack must be removable with one command")
        accept(stack.database, "AwsSolutions-RDS11", "the default PostgreSQL port inside a private subnet reachable from the HAPI task's security group alone; a non-default port adds nothing a security group does not")
        accept(stack.database, "AwsSolutions-SMG4", f"no rotation on the generated database secret: {synthetic}; the only reader is the HAPI task, which takes the secret at start")
        accept(_child(stack, "SeedFn"), "AwsSolutions-IAM5", "the seed function calls the reference API's FHIR and DICOMweb routes on any stage and method (SigV4); the routes themselves are named", applies_to=[regex(rf"^Resource::arn:{PARTITION}:execute-api:[^:]+:[^:]+:<\w+>/\*/\*/(fhir|dicom-web)(/\*)?$")])
    if isinstance(stack, HospitalServersStack):
        door = stack.node.try_find_child("ViewerDoorApi")
        if door is not None:
            accept(door, "AwsSolutions-APIG1", f"HTTP API access logs on the viewer's door: every request carries the panel's Cognito token and the door audits the study it opens; infrastructure access logs are {HANDOVER}")
        spill = stack.node.try_find_child("ViewerSpill")
        if spill is not None:
            accept(spill, "AwsSolutions-S1", f"server access logs on the viewer's spill bucket: short-lived rendered frames behind presigned URLs, expired by lifecycle rule; {HANDOVER}")


def apply_accepted_findings(scope: IConstruct) -> None:
    """Run both registers over every stack directly under `scope` — a hospital's stage (app.py), or an app in a test — after
    all its stacks exist, so cross-stack additions (the frontend config written into the API stack) are covered."""
    for stack in scope.node.children:
        if isinstance(stack, cdk.Stack):
            accept_platform_defaults(stack)
            accept_known_findings(stack)
