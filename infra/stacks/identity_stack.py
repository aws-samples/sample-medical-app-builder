"""
Identity — the hospital's single Cognito user pool that every app shares.

Design: infra/docs/identity.md. Encoded here:
  - one user pool per hospital deployment, email as username, admin-created users only
    (self sign-up off), TOTP MFA optional now / required via `mfa_required=True`
  - the invitation and the password-recovery emails in the panel's look, with the panel's URL
    (`email_templates.py`; `panel_url` is the hosting stack's origin, `invitation_language` en | de)
  - ONE app client for the web frontend (SRP, public SPA). Apps are manifests, not software, so
    they never get their own client; the frontend renders every app the registry holds
  - platform groups (authors / approvers / admins) decide who may create, iterate and sign off
    manifests; per-app role groups `app-{app_id}-{role}` are created at publish time by the
    lifecycle Lambda — never by CDK, because app creation must not be a CloudFormation event
  - a managed policy granting exactly the group-provisioning calls that Lambda will need
  - discovery via SSM parameters; outputs shaped for med_app/.env
"""

from __future__ import annotations

from typing import Mapping

from aws_cdk import (
    CfnOutput,
    Duration,
    RemovalPolicy,
    Stack,
    Tags,
    aws_cognito as cognito,
    aws_iam as iam,
    aws_ssm as ssm
)

from constructs import Construct
from medapp_shared.identity_model import PLATFORM_GROUPS, WEB_CLIENT_NAME

from .email_templates import Language, invitation_email, recovery_email

TEMP_PASSWORD_DAYS = 3


class IdentityStack(Stack):
    def __init__(self, scope: Construct, construct_id: str, *, hospital_id: str, hospital_name: str | None = None,
        mfa_required: bool = False, cognito_domain_prefix: str | None = None, panel_url: str | None = None,
        invitation_language: Language = "en", palette: Mapping[str, str] | None = None,
        **kwargs,
    ) -> None:
        """`palette`: the hospital's colours (HospitalConfig.palette) — the emails are in the panel's look, whatever it is."""
        super().__init__(scope, construct_id, **kwargs)

        Tags.of(self).add("medapp:hospital", hospital_id)
        Tags.of(self).add("medapp:layer", "1")
        Tags.of(self).add("medapp:component", "identity")

        # The hospital's display name, defined once for the whole deployment: the frontend shows it
        # (VITE_HOSPITAL_NAME) and the drafting agent speaks it. Everything else uses hospital_id.
        self.hospital_name = hospital_name or hospital_id

        # The emails the pool sends carry the hospital's name and the panel's URL (the hosting stack's origin, or a
        # custom domain from the context); without a URL the sign-in link is left out and the text still stands.
        invitation = invitation_email(hospital_name=self.hospital_name, panel_url=panel_url or "", language=invitation_language, valid_days=TEMP_PASSWORD_DAYS, palette=palette)
        recovery = recovery_email(hospital_name=self.hospital_name, panel_url=panel_url or "", language=invitation_language, palette=palette)

        # ── User pool ────────────────────────────────────────────────────────────────────────
        self.user_pool = cognito.UserPool(
            self,"UserPool",
            user_pool_name=f"medapp-{hospital_id}",
            self_sign_up_enabled=False,  # accounts come from the hospital (admin-created or federated)
            sign_in_aliases=cognito.SignInAliases(email=True),
            sign_in_case_sensitive=False,
            auto_verify=cognito.AutoVerifiedAttrs(email=True),
            standard_attributes=cognito.StandardAttributes(
                email=cognito.StandardAttribute(required=True, mutable=True),
                given_name=cognito.StandardAttribute(required=False, mutable=True),
                family_name=cognito.StandardAttribute(required=False, mutable=True),
            ),
            password_policy=cognito.PasswordPolicy(
                min_length=12,
                require_lowercase=True,
                require_uppercase=True,
                require_digits=True,
                require_symbols=True,
                temp_password_validity=Duration.days(TEMP_PASSWORD_DAYS),
            ),
            mfa=cognito.Mfa.REQUIRED if mfa_required else cognito.Mfa.OPTIONAL,
            mfa_second_factor=cognito.MfaSecondFactor(otp=True, sms=False),
            account_recovery=cognito.AccountRecovery.EMAIL_ONLY,
            email=cognito.UserPoolEmail.with_cognito(),
            feature_plan=cognito.FeaturePlan.ESSENTIALS,
            user_invitation=cognito.UserInvitationConfig(email_subject=invitation.subject, email_body=invitation.html),
            # The code the sign-in screen's "Forgot password" asks for (admin-created accounts never verify an address).
            user_verification=cognito.UserVerificationConfig(email_subject=recovery.subject, email_body=recovery.html, email_style=cognito.VerificationEmailStyle.CODE),
            deletion_protection=True,
            removal_policy=RemovalPolicy.RETAIN,
        )

        # ── The web frontend's app client (panel + app runtime are one SPA) ───────────────────
        # SRP only, no secret (public SPA). OAuth/hosted UI is enabled later for IdP federation.
        # A token from this client is a hospital SSO session; which apps it may touch, and in
        # which role, is decided per request from the token's groups — not from the client.
        self.web_client = self.user_pool.add_client(
            "WebClient",
            user_pool_client_name=WEB_CLIENT_NAME,
            auth_flows=cognito.AuthFlow(user_srp=True),
            generate_secret=False,
            prevent_user_existence_errors=True,
            enable_token_revocation=True,
            disable_o_auth=True,
            access_token_validity=Duration.minutes(60),
            id_token_validity=Duration.minutes(60),
            refresh_token_validity=Duration.hours(8),
            read_attributes=cognito.ClientAttributes().with_standard_attributes(
                email=True, email_verified=True, given_name=True, family_name=True
            ),
            # Cognito rule: every attribute marked *required* in the pool schema must be writable by
            # every app client, otherwise CreateUserPoolClient fails with "Invalid write attributes".
            # `email` is required above, so it has to be here even though users rarely change it.
            write_attributes=cognito.ClientAttributes().with_standard_attributes(email=True, given_name=True, family_name=True),
        )

        # ── Platform groups ──────────────────────────────────────────────────────────────────
        self.groups: dict[str, cognito.UserPoolGroup] = {}

        for name, (description, precedence) in PLATFORM_GROUPS.items():
            self.groups[name] = cognito.UserPoolGroup(
                self, "Group" + "".join(part.capitalize() for part in name.split("-")),
                user_pool=self.user_pool,
                group_name=name,
                description=description,
                precedence=precedence,
            )

        # ── Hosted UI domain (only needed once IdP federation starts; prefix must be unique) ──
        self.domain: cognito.UserPoolDomain | None = None

        if cognito_domain_prefix:
            self.domain = self.user_pool.add_domain(
                "Domain", cognito_domain=cognito.CognitoDomainOptions(domain_prefix=cognito_domain_prefix)
            )

        # ── What the publishing Lambda will need, and nothing more: role groups, no clients ─────
        self.group_provisioning_policy = iam.ManagedPolicy(
            self,"GroupProvisioningPolicy",
            managed_policy_name=f"medapp-{hospital_id}-identity-group-provisioning",
            statements=[
                iam.PolicyStatement(
                    sid="RoleGroups",
                    actions=[
                        "cognito-idp:CreateGroup",
                        "cognito-idp:GetGroup",
                        "cognito-idp:ListGroups",
                        "cognito-idp:AdminAddUserToGroup",
                        "cognito-idp:AdminRemoveUserFromGroup",
                        "cognito-idp:AdminListGroupsForUser",
                        "cognito-idp:ListUsersInGroup",
                    ],
                    resources=[self.user_pool.user_pool_arn],
                ),
            ],
        )

        # Users are deliberately NOT created here. A CloudFormation-managed user is deleted the
        # moment its resource leaves the template (e.g. a deploy without the flag that created it).
        # Accounts are operational data: create them with scripts/create-user.sh or the console.

        # ── Discovery for sibling stacks ─────────────────────────────────────────────────────
        prefix = f"/medapp/{hospital_id}/identity"

        ssm.StringParameter(self, "UserPoolIdParam", parameter_name=f"{prefix}/user-pool-id", string_value=self.user_pool.user_pool_id)
        ssm.StringParameter(self, "UserPoolArnParam", parameter_name=f"{prefix}/user-pool-arn", string_value=self.user_pool.user_pool_arn)
        ssm.StringParameter(self, "WebClientIdParam", parameter_name=f"{prefix}/web-client-id", string_value=self.web_client.user_pool_client_id)
        ssm.StringParameter(self, "HospitalNameParam", parameter_name=f"/medapp/{hospital_id}/name", string_value=self.hospital_name)

        if self.domain:
            ssm.StringParameter(self, "DomainParam", parameter_name=f"{prefix}/domain", string_value=self.domain.domain_name)

        # Outputs shaped for med_app/.env
        CfnOutput(self, "ViteCognitoRegion", value=self.region, description="VITE_COGNITO_REGION")
        CfnOutput(self, "ViteCognitoUserPoolId", value=self.user_pool.user_pool_id, description="VITE_COGNITO_USER_POOL_ID")
        CfnOutput(self, "ViteCognitoClientId", value=self.web_client.user_pool_client_id, description="VITE_COGNITO_CLIENT_ID")
        CfnOutput(self, "ViteHospitalName", value=self.hospital_name, description="VITE_HOSPITAL_NAME")
        CfnOutput(self, "UserPoolArn", value=self.user_pool.user_pool_arn)

        if self.domain:
            CfnOutput(self, "HostedUiBaseUrl", value=self.domain.base_url())
