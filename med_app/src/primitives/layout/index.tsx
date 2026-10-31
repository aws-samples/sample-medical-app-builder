import { Children, type ReactNode } from 'react';
import { Grid, Paper, SimpleGrid, Stack, Tabs as MantineTabs, Text, Title } from '@mantine/core';
import type { LayoutNode } from '../../manifest/schema';
import { useRenderContext } from '../../renderer/RenderContext';
import { tokens } from '../../theme';

/* Layout primitives. They own spacing and structure; they never touch clinical data. */

export function PageShell({ title, subtitle, children }: { title?: string; subtitle?: string; children?: ReactNode }) {
  // Who made this version — set by the runtime shell from the registry, never by the manifest (see RenderContext.byline).
  const { byline } = useRenderContext();
  return (
    <Stack gap="lg">
      {(title || subtitle || byline) && (
        <div>
          {title && <Title order={2}>{title}</Title>}
          {subtitle && (
            <Text c="dimmed" size="sm" mt={2}>
              {subtitle}
            </Text>
          )}
          {byline && (
            <Text size="xs" fw={500} mt={4} style={{ color: tokens.accent }} data-testid="author-line">
              By: {byline}
            </Text>
          )}
        </div>
      )}
      {children}
    </Stack>
  );
}

/**
 * Layouts respond to the width of the box they are rendered in, not the browser window (container
 * queries): an app looks the same in the runtime, in the drafting preview beside the chat, or on a
 * narrower screen — columns stack when their container is too narrow for them.
 */
const CONTAINER_BREAKPOINTS = { xs: '36em', sm: '48em', md: '62em', lg: '75em', xl: '88em' };

export function TwoColumn({ ratio = [7, 5], children }: { ratio?: [number, number]; children?: ReactNode }) {
  const [left, right] = Children.toArray(children);
  const total = ratio[0] + ratio[1];
  const span = (n: number) => Math.max(1, Math.round((n / total) * 12));
  return (
    <Grid gutter="md" align="stretch" type="container" breakpoints={CONTAINER_BREAKPOINTS}>
      <Grid.Col span={{ base: 12, md: span(ratio[0]) }}>{left}</Grid.Col>
      <Grid.Col span={{ base: 12, md: span(ratio[1]) }}>{right}</Grid.Col>
    </Grid>
  );
}

/**
 * Tiles: one column in a narrow box, two from a small one, all of them from a medium one. With
 * container queries the keys must be lengths — SimpleGrid writes them into `@container` rules as
 * given, so a theme name such as `sm` would silently disable the rule and leave a single column.
 */
export function GridLayout({ columns = 2, children }: { columns?: number; children?: ReactNode }) {
  return (
    <SimpleGrid cols={{ base: 1, [CONTAINER_BREAKPOINTS.sm]: Math.min(columns, 2), [CONTAINER_BREAKPOINTS.md]: columns }} spacing="md" type="container">
      {children}
    </SimpleGrid>
  );
}

export function Section({ title, description, children }: { title?: string; description?: string; children?: ReactNode }) {
  return (
    <Paper withBorder p="md" component="section" aria-label={title}>
      <Stack gap="sm">
        {(title || description) && (
          <div>
            {title && <Title order={4}>{title}</Title>}
            {description && (
              <Text size="sm" c="dimmed">
                {description}
              </Text>
            )}
          </div>
        )}
        {children}
      </Stack>
    </Paper>
  );
}

/**
 * Tabs need the *manifest nodes* of their children (for labels), not rendered elements,
 * so the catalog marks this entry `wantsChildNodes`. A tab gated to other roles is left out of
 * the strip altogether (the same rule RenderNode applies to its content), and the default tab
 * falls back to the first one this role can see.
 */
export function TabsLayout({ childNodes, default_tab }: { childNodes: LayoutNode[]; default_tab?: string }) {
  const { renderNode, role } = useRenderContext();
  const tabs = childNodes
    .map((node, i) => ({
      value: String(node.props?.['label'] ?? `tab-${i}`),
      label: String(node.props?.['label'] ?? `Tab ${i + 1}`),
      node,
    }))
    .filter((t) => !t.node.show_only_if_role_in || t.node.show_only_if_role_in.includes(role));
  if (!tabs.length) return null;
  const initial = tabs.some((t) => t.value === default_tab) ? default_tab : tabs[0]?.value;
  return (
    <MantineTabs defaultValue={initial} keepMounted={false}>
      <MantineTabs.List>
        {tabs.map((t) => (
          <MantineTabs.Tab key={t.value} value={t.value}>
            {t.label}
          </MantineTabs.Tab>
        ))}
      </MantineTabs.List>
      {tabs.map((t) => (
        <MantineTabs.Panel key={t.value} value={t.value} pt="md">
          {renderNode(t.node, t.value)}
        </MantineTabs.Panel>
      ))}
    </MantineTabs>
  );
}

export function Tab({ children }: { label?: string; children?: ReactNode }) {
  return <Stack gap="md">{children}</Stack>;
}
