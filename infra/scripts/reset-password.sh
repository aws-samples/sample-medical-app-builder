#!/usr/bin/env bash
# Reset a user's password in the hospital's Cognito user pool — the administrator's side of password recovery.
#
#   scripts/reset-password.sh <email>                # a new temporary password; the app asks for a new one at the next sign-in
#   scripts/reset-password.sh <email> --email-code   # instead: Cognito emails the user a code for the sign-in screen's "Forgot your password?"
#
# Environment:
#   AWS_PROFILE / AWS_REGION   as usual for the AWS CLI (the pool's region!)
#   HOSPITAL_ID                which hospital (the only one under infra/hospitals/ when unset); looks the pool up in SSM
#   USER_POOL_ID               skip the SSM lookup and use this pool
#
# People can reset their own password from the sign-in screen ("Forgot your password?") once they have signed in
# at least once. Two cases need an administrator: an account that never completed its first sign-in (the invitation
# expired or was lost — Cognito will not email such an account a code), and an account without a verified email.
# The default here works for both: it sets a temporary password that must be changed at the next sign-in, exactly
# like the invitation did. The temporary password is printed once, to the terminal, and nowhere else.
set -euo pipefail

email="${1:-}"
mode="${2:-}"
if [[ -z "$email" ]]; then
  echo "usage: $0 <email> [--email-code]" >&2
  exit 2
fi

# Which hospital: HOSPITAL_ID, or the only file under infra/hospitals/ — with several configured, say which (same rule as the Python scripts).
hospitals_dir="$(cd "$(dirname "$0")/.." && pwd)/hospitals"
hospital_id="${HOSPITAL_ID:-}"
if [[ -z "$hospital_id" ]]; then
  mapfile -t configured < <(ls "$hospitals_dir"/*.json 2>/dev/null | xargs -n1 basename 2>/dev/null | sed 's/\.json$//')
  if [[ ${#configured[@]} -eq 1 ]]; then
    hospital_id="${configured[0]}"
  else
    echo "set HOSPITAL_ID to one of: ${configured[*]:-<none configured under $hospitals_dir>}" >&2
    exit 2
  fi
fi
pool="${USER_POOL_ID:-}"
if [[ -z "$pool" ]]; then
  pool="$(aws ssm get-parameter --name "/medapp/${hospital_id}/identity/user-pool-id" --query Parameter.Value --output text)"
fi

status="$(aws cognito-idp admin-get-user --user-pool-id "$pool" --username "$email" --query UserStatus --output text 2>/dev/null || true)"
if [[ -z "$status" ]]; then
  echo "no such user in pool ${pool}: ${email}" >&2
  exit 1
fi

if [[ "$mode" == "--email-code" ]]; then
  if [[ "$status" == "FORCE_CHANGE_PASSWORD" ]]; then
    echo "${email} has never completed a sign-in (status ${status}); Cognito cannot email a code to such an account. Run without --email-code." >&2
    exit 1
  fi
  aws cognito-idp admin-reset-user-password --user-pool-id "$pool" --username "$email"
  echo "a reset code was emailed to ${email}; they finish on the sign-in screen with \"Forgot your password?\""
  exit 0
fi

# Random, and certainly within the pool's policy (12+ characters, upper and lower case, a digit, a symbol).
temporary="$(openssl rand -base64 24 | tr -dc 'A-Za-z0-9' | head -c 14)Tm1!"
aws cognito-idp admin-set-user-password --user-pool-id "$pool" --username "$email" --password "$temporary"
echo "temporary password for ${email}: ${temporary}"
echo "they sign in with it once and are asked to choose a new password (previous status: ${status})."
