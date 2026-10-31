#!/usr/bin/env bash
# Create (or update) a user in the hospital's Cognito user pool and put them in groups.
#
#   scripts/create-user.sh <email> [group ...]
#
#   scripts/create-user.sh dr.hoffmann@klinikum-musterstadt.example medapp-viewers
#   scripts/create-user.sh you@example.org medapp-admins medapp-authors medapp-approvers
#
# Environment:
#   AWS_PROFILE / AWS_REGION   as usual for the AWS CLI (the pool's region!)
#   HOSPITAL_ID                which hospital (the only one under infra/hospitals/ when unset); looks the pool up in SSM
#   USER_POOL_ID               skip the SSM lookup and use this pool
#
# Idempotent: an existing user is left alone (no new invitation), groups are added if missing.
# The invitation email carries a temporary password; the app asks for a new one at first sign-in.
set -euo pipefail

email="${1:-}"
if [[ -z "$email" ]]; then
  echo "usage: $0 <email> [group ...]" >&2
  exit 2
fi
shift
groups=("$@")

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

if aws cognito-idp admin-get-user --user-pool-id "$pool" --username "$email" >/dev/null 2>&1; then
  echo "user exists: $email"
else
  aws cognito-idp admin-create-user \
    --user-pool-id "$pool" \
    --username "$email" \
    --user-attributes Name=email,Value="$email" Name=email_verified,Value=true \
    --desired-delivery-mediums EMAIL >/dev/null
  echo "created: $email (invitation sent by email)"
fi

# ${arr[@]+"${arr[@]}"} expands to nothing for an empty array without tripping `set -u` on
# macOS's bash 3.2, where a plain "${groups[@]}" is reported as unbound.
for g in ${groups[@]+"${groups[@]}"}; do
  aws cognito-idp admin-add-user-to-group --user-pool-id "$pool" --username "$email" --group-name "$g"
  echo "  in group: $g"
done

echo "groups now: $(aws cognito-idp admin-list-groups-for-user --user-pool-id "$pool" --username "$email" --query 'Groups[].GroupName' --output text)"
