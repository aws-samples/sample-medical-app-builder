import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Badge, Button, Group, Text } from '@mantine/core';
import { IconLogout } from '@tabler/icons-react';
import { useAuth } from '../auth/AuthContext';
import { displayNameOf } from '../auth/types';
import type { Logo } from '../branding';
import { runtimeConfig } from '../config/env';
import { currentBranding, tokens } from '../theme';

export interface Crumb {
  readonly label: string;
  /** Route to navigate to; omit for the current page. */
  readonly to?: string;
}

/**
 * Persistent header, one row. Left: the hospital (a link home) and, on a page, its name —
 * `Klinikum Musterstadt › Longitudinal blood pressure`. Right: the signed-in person.
 * Only the page-name crumb may shrink (ellipsis); see `.crumbs` in styles.css.
 * The hospital shows as its logo when its branding gives one (src/branding.ts, or the hospital's own via config.json), with the name beside it unless the logo says it.
 *
 * Rendered as a plain <nav><ol> on purpose: Mantine's Breadcrumbs clones its children and
 * overwrites their `style`, which made truncation and line-height fixes impossible to apply.
 */
export function TopBar({ crumbs = [], right }: { crumbs?: readonly Crumb[]; right?: ReactNode }) {
  const { session, signOut, providerKind } = useAuth();
  const logo = currentBranding().logo;
  const trail: Crumb[] = [{ label: runtimeConfig.hospitalName, to: crumbs.length ? '/' : undefined }, ...crumbs];

  return (
    <Group
      component="header"
      justify="space-between"
      px="lg"
      py="sm"
      wrap="nowrap"
      gap="lg"
      style={{ background: tokens.surface, borderBottom: `1px solid ${tokens.line}`, position: 'sticky', top: 0, zIndex: 10 }}
    >
      <Group gap="md" wrap="nowrap" style={{ minWidth: 0, flex: 1 }}>
        <nav aria-label="Breadcrumb" style={{ minWidth: 0, overflow: 'hidden' }}>
          <ol className={`crumbs${logo ? ' has-logo' : ''}`}>
            {trail.map((crumb, i) => {
              const isCurrent = i === trail.length - 1;
              const isBrand = i === 0;
              const className = isBrand ? 'crumb crumb-brand' : isCurrent ? 'crumb crumb-current' : 'crumb';
              const content = isBrand && logo ? <Brand logo={logo} name={crumb.label} /> : crumb.label;
              return (
                <li key={i} className={className} aria-current={isCurrent ? 'page' : undefined} title={isCurrent ? crumb.label : undefined}>
                  {crumb.to && !isCurrent ? (
                    <Link to={crumb.to} className={isBrand && logo ? 'brand' : undefined}>
                      {content}
                    </Link>
                  ) : (
                    <span className={isBrand && logo ? 'brand' : undefined}>{content}</span>
                  )}
                </li>
              );
            })}
          </ol>
        </nav>
      </Group>

      <Group gap="sm" wrap="nowrap" style={{ flexShrink: 0 }}>
        {right}
        {providerKind === 'mock' && (
          <Badge color="orange" variant="filled" tt="none">
            mock auth
          </Badge>
        )}
        {session && (
          <Text size="sm" c="dimmed" truncate maw={220} title={session.claims.email}>
            {displayNameOf(session.claims)}
          </Text>
        )}
        <Button variant="subtle" size="xs" leftSection={<IconLogout size={14} />} onClick={() => void signOut()}>
          Sign out
        </Button>
      </Group>
    </Group>
  );
}

/** The hospital's logo and, unless the logo says it, its name — what the branding put in the top bar. */
function Brand({ logo, name }: { logo: Logo; name: string }) {
  return (
    <>
      <img src={logo.src} alt={logo.hideName ? logo.alt : ''} height={logo.height ?? 28} style={{ height: logo.height ?? 28 }} data-testid="brand-logo" />
      {!logo.hideName && <span>{name}</span>}
    </>
  );
}
