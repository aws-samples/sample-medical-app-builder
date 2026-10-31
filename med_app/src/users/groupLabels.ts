import type { RegistryEntry } from '../manifest/registry';
import { PLATFORM_GROUPS } from '../manifest/roles';
import type { GroupInfo } from './types';

/** How a platform group reads on a badge and in a form. */
export const PLATFORM_LABELS: Record<string, { short: string; title: string }> = {
  [PLATFORM_GROUPS.admins]: { short: 'Admin', title: 'Administrator' },
  [PLATFORM_GROUPS.approvers]: { short: 'Approver', title: 'Approver' },
  [PLATFORM_GROUPS.authors]: { short: 'Author', title: 'Author' },
  [PLATFORM_GROUPS.viewers]: { short: 'Viewer', title: 'Viewer' },
};

export const PLATFORM_ORDER: readonly string[] = [PLATFORM_GROUPS.admins, PLATFORM_GROUPS.approvers, PLATFORM_GROUPS.authors, PLATFORM_GROUPS.viewers];

export interface AppRoleGroup {
  readonly group: string;
  readonly app_id: string;
  readonly app_name: string;
  readonly role_id: string;
  readonly role_name: string;
}

/** `app-{app_id}-{role_id}` → its parts; role ids never contain hyphens, which is what makes the last one the split. */
export function parseAppRoleGroup(group: string): { app_id: string; role_id: string } | undefined {
  if (!group.startsWith('app-')) return undefined;
  const body = group.slice('app-'.length);
  const at = body.lastIndexOf('-');
  if (at <= 0 || at === body.length - 1) return undefined;
  return { app_id: body.slice(0, at), role_id: body.slice(at + 1) };
}

/**
 * The app role groups with the names their manifests give them — "Hypertension register · Hypertension clinic"
 * rather than `app-app_hypertension_register-hypertension_clinic`. A group whose app the registry does not list
 * (retired, or another deployment's) keeps its parsed parts as names.
 */
export function describeAppRoleGroups(groups: readonly GroupInfo[], registry: readonly RegistryEntry[]): AppRoleGroup[] {
  const byGroup = new Map<string, { app_id: string; app_name: string; role_id: string; role_name: string }>();
  for (const entry of registry) {
    if (!entry.ok) continue;
    for (const role of entry.manifest.auth.roles) {
      // Several versions may be listed; any of them names the app and the role the same way.
      if (!byGroup.has(role.cognito_group)) byGroup.set(role.cognito_group, { app_id: entry.manifest.metadata.app_id, app_name: entry.manifest.metadata.name, role_id: role.id, role_name: role.display_name });
    }
  }
  const out: AppRoleGroup[] = [];
  for (const g of groups) {
    if (g.kind !== 'app') continue;
    const known = byGroup.get(g.name);
    if (known) {
      out.push({ group: g.name, ...known });
      continue;
    }
    const parsed = parseAppRoleGroup(g.name);
    out.push({ group: g.name, app_id: parsed?.app_id ?? g.name, app_name: parsed?.app_id ?? g.name, role_id: parsed?.role_id ?? '', role_name: parsed?.role_id ?? g.name });
  }
  return out.sort((a, b) => a.app_name.localeCompare(b.app_name) || a.role_name.localeCompare(b.role_name));
}

/** App role groups by app, in app-name order — the shape the forms render. */
export function groupByApp(roles: readonly AppRoleGroup[]): { app_id: string; app_name: string; roles: AppRoleGroup[] }[] {
  const apps = new Map<string, { app_id: string; app_name: string; roles: AppRoleGroup[] }>();
  for (const r of roles) {
    const app = apps.get(r.app_id) ?? { app_id: r.app_id, app_name: r.app_name, roles: [] };
    app.roles.push(r);
    apps.set(r.app_id, app);
  }
  return [...apps.values()];
}

/** A member's groups in the order the table shows them: platform first (by precedence), then app roles, then the rest. */
export function partitionGroups(groups: readonly string[], appRoles: readonly AppRoleGroup[]): { platform: string[]; apps: AppRoleGroup[]; other: string[] } {
  const byName = new Map(appRoles.map((r) => [r.group, r]));
  const platform = PLATFORM_ORDER.filter((g) => groups.includes(g));
  const apps: AppRoleGroup[] = [];
  const other: string[] = [];
  for (const g of groups) {
    if (PLATFORM_ORDER.includes(g)) continue;
    const role = byName.get(g);
    if (role) apps.push(role);
    else if (parseAppRoleGroup(g)) {
      const parsed = parseAppRoleGroup(g)!;
      apps.push({ group: g, app_id: parsed.app_id, app_name: parsed.app_id, role_id: parsed.role_id, role_name: parsed.role_id });
    } else other.push(g);
  }
  return { platform, apps, other };
}
