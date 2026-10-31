/**
 * User administration — the accounts in the hospital's user pool and what they may open. Mirrors the
 * user_admin Lambda's contract (infra/lambdas/user_admin/handler.py); the local client re-implements it over
 * memory for mock mode and tests.
 */

export type GroupKind = 'platform' | 'app' | 'hospital';

export interface GroupInfo {
  readonly name: string;
  readonly description: string;
  /** The four medapp-* groups, the per-app role groups `app-{app_id}-{role}`, or a group the hospital already has. */
  readonly kind: GroupKind;
}

/** Cognito's account statuses the panel tells apart; anything else is shown as is. */
export type AccountStatus = 'CONFIRMED' | 'FORCE_CHANGE_PASSWORD' | 'UNCONFIRMED' | 'RESET_REQUIRED' | 'ARCHIVED' | 'COMPROMISED' | 'UNKNOWN' | (string & {});

export interface ManagedUser {
  /** The pool's username — opaque on an email-as-username pool; what the API addresses, never what is shown. */
  readonly username: string;
  readonly sub?: string | null;
  readonly email?: string | null;
  readonly given_name?: string | null;
  readonly family_name?: string | null;
  readonly name?: string | null;
  readonly enabled: boolean;
  readonly status?: AccountStatus | null;
  readonly groups: readonly string[];
  readonly created_at?: string | null;
  readonly updated_at?: string | null;
}

export interface UserListing {
  readonly users: ManagedUser[];
  /** The pool has more accounts than one page; narrow with a search. */
  readonly truncated: boolean;
}

export interface RegisterUserInput {
  readonly email: string;
  readonly given_name?: string;
  readonly family_name?: string;
  readonly groups?: readonly string[];
}

export interface UserPatch {
  readonly enabled?: boolean;
  readonly add_groups?: readonly string[];
  readonly remove_groups?: readonly string[];
}

export class UsersApiError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
    this.name = 'UsersApiError';
  }
}

export interface UsersClient {
  readonly kind: 'remote' | 'local';
  /** One page of accounts, by email prefix when `search` is given, each with its groups. */
  list(search?: string): Promise<UserListing>;
  groups(): Promise<GroupInfo[]>;
  /** Creates the account and sends the invitation email (temporary password); the groups are added in the same step. */
  register(input: RegisterUserInput): Promise<ManagedUser>;
  update(username: string, patch: UserPatch): Promise<ManagedUser>;
  /** While the first sign-in is pending only. */
  resendInvitation(username: string): Promise<ManagedUser>;
}

/** "Invited" until the first sign-in, then "Active" — or "Disabled", which wins. */
export function accountState(user: Pick<ManagedUser, 'enabled' | 'status'>): 'active' | 'invited' | 'disabled' | 'reset' {
  if (!user.enabled) return 'disabled';
  if (user.status === 'FORCE_CHANGE_PASSWORD' || user.status === 'UNCONFIRMED') return 'invited';
  if (user.status === 'RESET_REQUIRED') return 'reset';
  return 'active';
}

export function displayNameOfUser(user: ManagedUser): string {
  return user.name || user.email || user.username;
}
