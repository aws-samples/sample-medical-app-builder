import type { RegistryEntry } from '../manifest/registry';
import { PLATFORM_GROUPS } from '../manifest/roles';
import { UsersApiError, type GroupInfo, type ManagedUser, type RegisterUserInput, type UserPatch, type UsersClient } from './types';

/** The platform groups as identity_model.py describes them, in precedence order. */
export const PLATFORM_GROUP_INFO: readonly GroupInfo[] = [
  { name: PLATFORM_GROUPS.admins, description: 'Registry and identity administration; manages group membership; opens every app in its default role', kind: 'platform' },
  { name: PLATFORM_GROUPS.approvers, description: 'Clinical sign-off: may move versions to approved / published; opens every app in its default role', kind: 'platform' },
  { name: PLATFORM_GROUPS.authors, description: 'May create and iterate app manifests through the panel', kind: 'platform' },
  { name: PLATFORM_GROUPS.viewers, description: 'Blanket access: opens every app in its default role', kind: 'platform' },
];

export interface LocalUsersOptions {
  /** The registry as the panel holds it — the published apps' role groups are the pool's `app-*` groups. */
  readonly registry: () => readonly RegistryEntry[];
  /** The signed-in person: seeded as an administrator so the lock-out guards can be seen at work. */
  readonly caller: () => { sub: string; email?: string; name?: string } | undefined;
  readonly storage?: Pick<Storage, 'getItem' | 'setItem'>;
  readonly now?: () => Date;
  readonly delayMs?: number;
}

const STORAGE_KEY = 'med_app.local_users';
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

interface Account extends ManagedUser {
  readonly groups: string[];
}

function seedAccounts(now: Date): Account[] {
  const day = (n: number) => new Date(now.getTime() - n * 86_400_000).toISOString();
  const account = (username: string, email: string, given: string | null, family: string | null, groups: string[], status: string, createdDaysAgo: number, enabled = true): Account => ({
    username,
    sub: `sub-${username}`,
    email,
    given_name: given,
    family_name: family,
    name: [given, family].filter(Boolean).join(' ') || null,
    enabled,
    status,
    groups,
    created_at: day(createdDaysAgo),
    updated_at: day(Math.max(0, createdDaysAgo - 1)),
  });
  return [
    account('u-hoffmann', 'lukas.hoffmann@klinikum-musterstadt.example', 'Lukas', 'Hoffmann', [PLATFORM_GROUPS.authors, PLATFORM_GROUPS.viewers], 'CONFIRMED', 40),
    account('u-weber', 'sabine.weber@klinikum-musterstadt.example', 'Sabine', 'Weber', [PLATFORM_GROUPS.approvers], 'CONFIRMED', 38),
    account('u-neumann', 'karin.neumann@klinikum-musterstadt.example', 'Karin', 'Neumann', ['app-app_hypertension_follow_up-hypertension_nurse', 'app-app_hypertension_register-hypertension_clinic'], 'CONFIRMED', 21),
    account('u-brandt', 'tobias.brandt@klinikum-musterstadt.example', 'Tobias', 'Brandt', ['app-app_imaging_3d-radiologist'], 'FORCE_CHANGE_PASSWORD', 2),
    account('u-schulz', 'm.schulz@klinikum-musterstadt.example', null, null, [PLATFORM_GROUPS.viewers], 'CONFIRMED', 90, false),
  ];
}

/**
 * The user administration API over memory — for mock mode and tests. Same rules as the Lambda: admins only is
 * decided by the page (the local client trusts its caller), the two lock-out guards hold, unknown groups are
 * refused, invitations can be re-sent while the first sign-in is pending. Accounts survive a reload through
 * sessionStorage, like locally authored apps do.
 */
export function localUsersClient(opts: LocalUsersOptions): UsersClient {
  const now = opts.now ?? (() => new Date());
  const delay = () => new Promise<void>((r) => setTimeout(r, opts.delayMs ?? 80));
  let accounts: Account[] | null = null;

  function load(): Account[] {
    if (accounts) return accounts;
    const raw = opts.storage?.getItem(STORAGE_KEY);
    if (raw) {
      try {
        accounts = JSON.parse(raw) as Account[];
      } catch {
        accounts = null;
      }
    }
    accounts ??= seedAccounts(now());
    return accounts;
  }

  function save(): void {
    opts.storage?.setItem(STORAGE_KEY, JSON.stringify(load()));
  }

  /** The signed-in person is an account too — an administrator, so "yourself" exists in the list. */
  function ensureCaller(): void {
    const caller = opts.caller();
    if (!caller || load().some((a) => a.sub === caller.sub)) return;
    load().unshift({
      username: `u-${caller.sub}`,
      sub: caller.sub,
      email: caller.email ?? null,
      given_name: null,
      family_name: null,
      name: caller.name ?? null,
      enabled: true,
      status: 'CONFIRMED',
      groups: [PLATFORM_GROUPS.admins, PLATFORM_GROUPS.authors],
      created_at: now().toISOString(),
      updated_at: now().toISOString(),
    });
    save();
  }

  function groupList(): GroupInfo[] {
    const appGroups = new Map<string, GroupInfo>();
    for (const entry of opts.registry()) {
      if (!entry.ok) continue;
      const { state } = entry.manifest.lifecycle;
      if (state !== 'published' && state !== 'deprecated') continue; // role groups come into being at publish time
      for (const role of entry.manifest.auth.roles) {
        if (role.cognito_group.startsWith('app-')) appGroups.set(role.cognito_group, { name: role.cognito_group, description: `${entry.manifest.metadata.name} · ${role.display_name}`, kind: 'app' });
      }
    }
    return [...PLATFORM_GROUP_INFO, ...[...appGroups.values()].sort((a, b) => a.name.localeCompare(b.name))];
  }

  function requireKnown(groups: readonly string[]): void {
    const known = new Set(groupList().map((g) => g.name));
    const unknown = groups.filter((g) => !known.has(g));
    if (unknown.length) throw new UsersApiError(400, `Not a group in this hospital's user pool: ${unknown.join(', ')}.`);
  }

  function find(username: string): Account {
    const account = load().find((a) => a.username === username);
    if (!account) throw new UsersApiError(404, `No account '${username}' in this hospital's user pool.`);
    return account;
  }

  const present = (a: Account): ManagedUser => ({ ...a, groups: [...a.groups].sort() });

  return {
    kind: 'local',

    async list(search) {
      await delay();
      ensureCaller();
      const needle = (search ?? '').trim().toLowerCase();
      const users = load()
        .filter((a) => !needle || (a.email ?? '').toLowerCase().startsWith(needle))
        .sort((a, b) => (a.email ?? '').localeCompare(b.email ?? ''))
        .map(present);
      return { users, truncated: false };
    },

    async groups() {
      await delay();
      return groupList();
    },

    async register(input: RegisterUserInput) {
      await delay();
      const email = input.email.trim().toLowerCase();
      if (!EMAIL.test(email)) throw new UsersApiError(400, "A valid email address is required; it is the account's username.");
      if (load().some((a) => a.email === email)) throw new UsersApiError(409, `An account for ${email} already exists.`);
      const groups = [...new Set(input.groups ?? [])];
      requireKnown(groups);
      const given = input.given_name?.trim() || null;
      const family = input.family_name?.trim() || null;
      const account: Account = {
        username: `u-${Math.random().toString(36).slice(2, 10)}`,
        sub: `sub-${Math.random().toString(36).slice(2, 10)}`,
        email,
        given_name: given,
        family_name: family,
        name: [given, family].filter(Boolean).join(' ') || null,
        enabled: true,
        status: 'FORCE_CHANGE_PASSWORD',
        groups,
        created_at: now().toISOString(),
        updated_at: now().toISOString(),
      };
      load().push(account);
      save();
      return present(account);
    },

    async update(username, patch: UserPatch) {
      await delay();
      ensureCaller();
      const account = find(username);
      const isSelf = !!account.sub && account.sub === opts.caller()?.sub;
      const add = [...new Set(patch.add_groups ?? [])].filter((g) => !account.groups.includes(g));
      const remove = [...new Set(patch.remove_groups ?? [])].filter((g) => account.groups.includes(g));
      if (add.some((g) => remove.includes(g))) throw new UsersApiError(400, 'A group cannot be both added and removed.');
      requireKnown(add);
      if (isSelf && patch.enabled === false) throw new UsersApiError(400, 'You cannot disable your own account.');
      if (isSelf && remove.includes(PLATFORM_GROUPS.admins)) throw new UsersApiError(400, 'You cannot remove yourself from medapp-admins; ask another administrator.');
      const next: Account = {
        ...account,
        groups: [...account.groups.filter((g) => !remove.includes(g)), ...add],
        enabled: patch.enabled ?? account.enabled,
        updated_at: now().toISOString(),
      };
      const all = load();
      all[all.indexOf(account)] = next;
      save();
      return present(next);
    },

    async resendInvitation(username) {
      await delay();
      const account = find(username);
      if (account.status !== 'FORCE_CHANGE_PASSWORD') throw new UsersApiError(409, 'This account has already completed its first sign-in; use the password recovery on the sign-in screen instead.');
      return present(account);
    },
  };
}
