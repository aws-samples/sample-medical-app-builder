import { Text } from '@mantine/core';
import { tokens } from '../theme';

/**
 * "By: Lukas Hoffmann" — who made a version, in the panel's accent, under an app's description in the registry and
 * on the app's own page. Renders nothing when the version carries no author (saved before names were kept).
 */
export function AuthorLine({ label, size = 'xs', ...rest }: { label: string | undefined; size?: 'xs' | 'sm'; 'data-testid'?: string }) {
  if (!label) return null;
  return (
    <Text size={size} fw={500} mt={2} style={{ color: tokens.accent }} data-testid={rest['data-testid'] ?? 'author-line'}>
      By: {label}
    </Text>
  );
}
