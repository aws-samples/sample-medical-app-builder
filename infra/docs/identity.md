# Identity — one user pool, one web client, groups do the work

`stacks/identity_stack.py` creates the Cognito user pool that every app in a hospital deployment
shares. Two decisions shape it:

1. **One pool per hospital**, federated once to the hospital IdP (later), with per-app *role groups*
   on top — not a pool per app.
2. **One app client for the web frontend.** A Cognito app client identifies a piece of software
   requesting tokens. There is one piece of software — the SPA in `med_app/` — and it renders every
   app the registry holds. Apps are manifests, not software, so they never get their own client.
   Additional clients only appear for genuinely different software (a machine-to-machine client for
   the pipeline, an EHR/SMART integration), never for manifests.

A token is therefore a hospital SSO session. *Which* apps it may touch, and in which role, is
decided **per request**: the dispatcher reads `app_id` + `manifest_version` from the request, the
role from the token's `cognito:groups`, and enforces the scope stored on that immutable version.
No per-app token claims, no pre-token Lambda, no token switching when a clinician opens a second app.

## What exists after `cdk deploy`

| Resource | Name / convention | Notes |
|---|---|---|
| User pool | `medapp-{hospital_id}` | email is the username; self sign-up off; TOTP MFA optional (`-c mfa_required=true` → required); 12-char password policy; email-only recovery; deletion protection; `RETAIN` |
| App client | `medapp-web` | the SPA (panel + app runtime). SRP only, no secret, token revocation on, 60-min tokens, 8-hour refresh |
| Groups | `medapp-admins`, `medapp-approvers`, `medapp-authors`, `medapp-viewers` | platform capabilities — see "Who may do what" |
| Managed policy | `medapp-{hospital_id}-identity-group-provisioning` | exactly the `CreateGroup` / `Admin*Group` calls the publish Lambda needs, scoped to the pool |
| SSM | `/medapp/{hospital_id}/identity/{user-pool-id, user-pool-arn, web-client-id[, domain]}` | discovery for sibling stacks |
| Hosted-UI domain | `-c cognito_domain_prefix=…` | only when set; needed once SAML/OIDC federation starts |

**Users are not stack resources.** A CloudFormation-managed user is deleted the moment its resource
leaves the template — a deploy without the flag that created it is enough. Accounts are operational
data, created out-of-band and idempotently:

```bash
scripts/create-user.sh dr.hoffmann@klinikum-musterstadt.example medapp-viewers                      # sees every app
scripts/create-user.sh you@example.org medapp-admins medapp-authors medapp-approvers
```

The script looks the pool up in SSM (`HOSPITAL_ID`, default `hsp-musterstadt`), creates the user if
missing (invitation email with a temporary password), and adds the groups. Group changes take
effect at the next sign-in, since membership travels in the token.

Wire the frontend from the stack outputs:

```
VITE_AUTH_MODE=cognito
VITE_COGNITO_REGION=<ViteCognitoRegion>
VITE_COGNITO_USER_POOL_ID=<ViteCognitoUserPoolId>
VITE_COGNITO_CLIENT_ID=<ViteCognitoClientId>
```

The sign-in screen handles the first-login `NEW_PASSWORD_REQUIRED` challenge the demo user will hit.
It does **not** yet handle the TOTP challenge, which is why MFA defaults to optional; switch to
`mfa_required=true` once that step exists.

## Who may do what

Two kinds of groups, one mechanism. Conventions and the decision functions live in
`medapp_shared/identity_model.py`; the frontend mirrors the per-app convention in
`med_app/src/manifest/roles.ts`.

**Using apps — the group each role declares.** Every role in a manifest names its `cognito_group`,
and that exact string is what grants the role (frontend and dispatcher alike). By convention the
pipeline names it `app-{app_id}-{role_id}` and the lifecycle Lambda creates it when the version is
first published, so an administrator adds people to that app's group. But a manifest may bind a
role to a group the hospital **already has** — a department, a ward, an IdP-mapped group — in which
case nobody is added app by app: when the app is published, everyone in `cardiology-physicians`
can open it. "Who should use this app?" is therefore a question the authoring pipeline can ask and
answer inside the manifest. Role ids never contain hyphens (manifest schema), which keeps the
conventional name parseable for hyphenated app ids.

**Using every app — blanket access.** Members of `medapp-viewers` (and of `medapp-approvers` and
`medapp-admins`, who need it to review and administer) may open every app, running as that
manifest's `default_role`. This is what `default_role` means: the role blanket access resolves to —
by convention the least privileged role the app declares. Per-app groups still add more capable
roles on top; the most capable wins. `effective_roles()` in `medapp_shared/identity_model.py` is
the single definition both the dispatcher and the frontend follow, and an empty result means refuse.

Grant it from the panel's **User management** section (administrators; see below), with the console
(User pools → users → add to group) or the CLI:

```bash
aws cognito-idp admin-add-user-to-group --user-pool-id <pool> --username <email> --group-name medapp-viewers
```

A privacy note for the pilot: blanket access means seeing real patient data through every app.
For approvers that is the point of sign-off, but the hospital may prefer reviews to run against a
test patient; that is a policy choice, and the mechanism supports either. What an approver signs is
shown to them as a difference: the panel's review page compares the version with the published one and
names, first, every way a role would reach data, patients or identity fields it cannot today — so a
widened scope cannot pass as a cosmetic change.

**Authoring apps — platform groups.** Enforced by the registry write API from the token's groups:

| Action | Who | Rule |
|---|---|---|
| Create a new app (first draft) | `medapp-authors`, `medapp-admins` | `can_author` |
| New version of an existing app | its owner (if still an author), or an admin | `can_iterate` — two authors can't silently fork each other's app |
| `in_review → approved`, `approved → published` | `medapp-approvers`, `medapp-admins` — **never the version's own author** | `can_approve` — separation of duties, which is what a notified body expects to see |
| Deprecate | owner, approvers, admins | |
| Curate the launcher's collections (group published apps for a clinic, a ward, a team) | `medapp-approvers`, `medapp-admins` | `can_curate` — organisation, not a clinical change; no version moves, nothing is re-reviewed. Authors propose, the governance people place |
| Manage group membership | `medapp-admins` | `can_manage_membership` |
| **Preview an app as any of its roles** | `medapp-approvers`, `medapp-admins` on every app; `medapp-authors` on apps they own | `runnable_roles` — the dispatcher allows it and records `role_source: staff_preview` on the audit record, so a reviewer looking at the reviewer view is on record. Blanket viewers get the default role only. |

Everyone else can sign in (they are hospital staff) and sees only the apps their groups grant —
per-app or blanket — **and only published versions**. Drafts and versions in review are workflow
state, visible to and openable by authors, approvers and admins only. The launcher filters on both;
the dispatcher enforces both.

## A new account sees nothing — by design

A person who signs in with no groups sees an empty launcher ("No published apps are available to you yet…").
Access is never implied by having an account: the registry API returns, for a non-staff caller, only the
published apps for which `effective_roles()` is non-empty — a role whose group the caller is in
(`app-<app_id>-<role>`, or an existing hospital group the manifest bound the role to), or the manifest's
default role through blanket access (`medapp-viewers`, approvers and admins). Hidden apps are not listed,
so there is no oracle; the launcher can only say how access is granted. The usual grants:

```bash
scripts/create-user.sh dr.hoffmann@klinikum-musterstadt.example medapp-viewers                  # every published app, default role
scripts/create-user.sh nurse.k@klinikum-musterstadt.example app-app_htn_assessment-nurse          # one app, one role
aws cognito-idp admin-add-user-to-group --user-pool-id <pool> --username <email> --group-name medapp-viewers
```

Role groups come into being when an app is published through the API; `scripts/seed-registry.py` creates
them too for the example manifests it writes as published (`--no-groups` to skip). Staff groups add
visibility rather than roles: authors see their own drafts, approvers and admins every version in every
state, and admins hold blanket access as well — which is why an account dropped into `medapp-admins` sees
everything at once.

## Managing accounts from the panel

Members of `medapp-admins` get a third section in the panel's sidebar, **User management** — the accounts of the
pool with their groups and status, and the three things an administrator does:

- **Register** a person: email (the username), optional names, and the groups they start with. The account is
  created with `AdminCreateUser` and Cognito emails the invitation with a temporary password — the same as
  `scripts/create-user.sh`, from the panel. While the first sign-in is pending the account shows as *Invited* and
  the invitation can be re-sent; afterwards password recovery is the person's own (sign-in screen).
- **Decide groups**: the four platform groups, the role groups of every published app (named after the app and
  the role as the manifest calls them — "Hypertension register · Hypertension clinic", the group id underneath),
  and any group the hospital already has in the pool. The groups are a form: tick and untick, then *Save changes*
  sends every addition and removal in one request (`PATCH /users/{username}` with `add_groups` / `remove_groups`,
  one `AdminAddUserToGroup` / `AdminRemoveUserFromGroup` each, server-side); the change takes effect at the
  person's next token refresh.
- **Disable / enable access** (`AdminDisableUser` / `AdminEnableUser`). Nothing deletes an account: audit records
  and sign-offs stay attributable to a person who has left.

Two guards keep an administrator from locking everyone out: you cannot disable your own account, and you cannot
remove yourself from `medapp-admins` — another administrator does that. The API (`lambdas/user_admin`, routes
`/users…` on the HTTP API) checks `medapp-admins` on the caller's token itself; the authorizer only checks the
token. Its IAM policy names the user and group calls on this one pool — no deletion, no pool or client settings.
Every change is an audit record (`kind: platform.user.create | groups | enable | disable | invite`, the acting
administrator, the account, the groups added and removed) — in the function's log and in the audit table the panel's
Audit trail section shows to administrators (`docs/audit.md`); Cognito's CloudTrail entries are a further copy. The list is one
page of the pool (60 accounts) with an email-prefix search for the rest; membership is read with one
`ListUsersInGroup` per group rather than one call per user.

In mock mode (`VITE_REGISTRY_MODE=local`) the section runs over seeded accounts in the browser — sign in as
`name+medapp-admins` — so the flow can be tried without a pool.

## What happens at publish time

On the transition to `published`, the lifecycle Lambda — with the group-provisioning policy above —
creates `app-{app_id}-{role_id}` for each role in the manifest (idempotent: `CreateGroup` on an
existing name is treated as success). Nothing else changes in Cognito: no client, no callback URL,
no CloudFormation. Groups are kept when a version is deprecated so historic tokens and audit records
stay attributable; an app that is retired entirely has its groups removed by an admin.

The same transition writes the app's own FHIR definitions to the record: the Questionnaires of forms
designed in the drafting conversation (manifest `artifacts.questionnaires`). The registry write API
hands them to the data source's seed Lambda (`task: definitions`, found through the SSM parameter
`/medapp/<hospital_id>/data-source/definitions-writer`, invoked asynchronously), which PUTs each by id
and looks it up by canonical URL afterwards — the same path the deploy-time seed uses for the
record's own questionnaires. It is a courtesy copy, so that a QuestionnaireResponse on the record
resolves for other systems: the app reads and validates the form from its manifest, and a failed
write (logged as `definitions … failed`) never undoes a publish. Before publication the form exists in
the manifest only: a reviewer can fill it in and submit — the dispatcher validates against the manifest's
copy — and the QuestionnaireResponse lands on the record with a canonical URL that resolves once the
version is published (a canonical is a URI, not a server reference; HAPI accepts it unresolved). That is
accepted as is: review-time submissions are test documentation, which on a production deployment should be
made against a test patient. Writing a `draft` Questionnaire at save time would need version-carrying
canonicals (`url|version`) so a draft never overwrites the published form; not done.

## Passwords: first sign-in and recovery

Accounts are created by an administrator (the panel's User management, or `scripts/create-user.sh`), which
marks the email verified and sends an invitation with a temporary password; the sign-in screen asks for a new
one the first time (Cognito's `NEW_PASSWORD_REQUIRED` challenge). The policy is the pool's: at least 12
characters with upper and lower case, a digit and a symbol.

**The emails.** Both messages the pool sends — the invitation and the recovery code — are the panel's own
(`stacks/email_templates.py`): the sign-in screen's brand band (the wordmark, the hospital's name on ink), a
white card with the account details, a green button to the panel and the plain URL beside it, the validity of
the temporary password (the pool's `temp_password_validity`, quoted from the same constant), and a quiet footer
saying what to do if the message was not expected. Table layout and inline styles only, no images, a system
font stack: what renders in Outlook and on a phone alike. Cognito fills `{username}` and `{####}`; everything
else is fixed at deploy — the hospital's name from `hospital_name`, the panel's URL from the hosting stack's
CloudFront origin (or `panel_url` in the context once there is a custom domain), the language from
`invitation_language` (`en`, the default, or `de`). `scripts/preview-emails.py` writes the rendered files to
`.build/emails/` to look at before a deploy; the unit tests check the placeholders, the limits and the escaping
of whatever a hospital's name contains. Changing a template is an in-place update of the pool.

**Self-service.** "Forgot your password?" on the sign-in screen runs the pool's own recovery
(`account_recovery: EMAIL_ONLY`): Cognito emails a code to the verified address, the person enters it with a
new password, and the screen signs them in with it — no second trip through the form. The code is short-lived;
"Send a new code" asks for another. Cognito's errors are turned into instructions (wrong or expired code, too
many attempts, a password outside the policy). Emails come from Cognito's default sender
(`no-reply@verificationemail.com`, fifty a day), which is enough for a prototype but lands in spam folders at
some hospitals and cannot carry the hospital's own sender address; a verified SES identity
(`UserPoolEmail.with_ses`, a domain the hospital's DNS vouches for) is the production answer — the templates
stay the same.

**Administrator.** Two accounts cannot recover themselves: one that never completed its first sign-in
(Cognito answers "User password cannot be reset in the current state"; the screen says to ask for a new
invitation) and one without a verified email. `scripts/reset-password.sh <email>` sets a new temporary
password for either — printed once, to the terminal — and the next sign-in asks for a new one, exactly like
the invitation did. `scripts/reset-password.sh <email> --email-code` instead makes Cognito email a recovery
code, for a person who prefers to finish on the screen. The mock provider accepts any six-digit code, so the
flow can be exercised without a pool.

## Federation (later)

When the hospital's IdP metadata is available: `UserPoolIdentityProviderSaml` (or OIDC) on this
pool, the hosted-UI domain, and OAuth on the single web client. Group membership can be driven from
IdP attributes with a pre-token trigger *at that point* — that is the only reason one would appear.
Nothing in the registry, the dispatcher or the frontend changes.

## Why a separate stack from the registry

Replacing a user pool means losing every user and every group membership. Keeping identity in its
own stack means schema changes to the registry table can never put the pool at risk, and the pool
can be deployed and tested before the registry API exists. Both stacks are one CDK app and one
platform release.
