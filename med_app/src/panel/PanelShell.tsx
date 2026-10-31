import type { ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import { IconApps, IconForms, IconHistory, IconPuzzle, IconUsers, type IconProps } from '@tabler/icons-react';
import { useAuth } from '../auth/AuthContext';
import type { IdentityClaims } from '../auth/types';
import { isAdmin, isPlatformStaff } from '../manifest/roles';
import { TopBar, type Crumb } from './TopBar';

export interface PanelSection {
  readonly to: string;
  readonly label: string;
  readonly icon: (props: IconProps) => ReactNode;
  readonly end?: boolean;
}

/** The panel's sections, for this person: staff see the registry, the record-shape library and the catalog, administrators the accounts and the audit trail too. */
export function panelSections(claims: IdentityClaims | undefined, isMock: boolean): PanelSection[] {
  const staff = isMock || (claims ? isPlatformStaff(claims) : false);
  if (!staff) return [];
  const sections: PanelSection[] = [
    { to: '/', label: 'App registry', icon: IconApps, end: true },
    { to: '/shapes', label: 'Record shapes', icon: IconForms },
    { to: '/catalog', label: 'Components and data primitives', icon: IconPuzzle },
  ];
  if (claims && isAdmin(claims)) sections.push({ to: '/users', label: 'User management', icon: IconUsers }, { to: '/audit', label: 'Audit trail', icon: IconHistory });
  return sections;
}

/**
 * The frame of the panel pages — registry, catalog, user management, audit trail: the top bar, and for staff a sidebar
 * naming the sections (administrators get the accounts and the trail too). Clinicians see the registry alone, as
 * before: a sidebar with one entry would be furniture. Running apps and the composer are not panel pages; they keep
 * the whole width.
 */
export function PanelShell({ crumbs, isMock, children }: { crumbs?: readonly Crumb[]; isMock: boolean; children: ReactNode }) {
  const { session } = useAuth();
  const sections = panelSections(session?.claims, isMock);
  if (!sections.length) {
    return (
      <>
        <TopBar crumbs={crumbs} />
        {children}
      </>
    );
  }
  return (
    <>
      <TopBar crumbs={crumbs} />
      <div className="panel-body">
        <nav className="panel-nav" aria-label="Panel sections" data-testid="panel-nav">
          {sections.map((s) => (
            <NavLink key={s.to} to={s.to} end={s.end} className={({ isActive }) => `panel-nav-link${isActive ? ' is-active' : ''}`}>
              <s.icon size={16} stroke={1.75} aria-hidden />
              <span>{s.label}</span>
            </NavLink>
          ))}
        </nav>
        <main className="panel-main">{children}</main>
      </div>
    </>
  );
}
