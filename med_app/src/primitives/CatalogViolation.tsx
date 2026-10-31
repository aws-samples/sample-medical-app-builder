import { Alert, Code, Text } from '@mantine/core';
import { IconAlertTriangle } from '@tabler/icons-react';

/**
 * Rendered when a manifest references something outside the validated catalog.
 * This is the correct behaviour for a medical device: refuse visibly, never improvise.
 */
export function CatalogViolation({
  kind,
  name,
  detail,
}: {
  kind: 'component' | 'data_primitive' | 'scope';
  name: string;
  detail?: string;
}) {
  const title =
    kind === 'component'
      ? 'Component is not in the catalog'
      : kind === 'data_primitive'
        ? 'Data primitive is not in the catalog'
        : 'Request refused by data scope';
  return (
    <Alert color="red" variant="outline" icon={<IconAlertTriangle size={18} />} title={title} role="alert">
      <Text size="sm">
        <Code>{name}</Code>
        {detail ? ` — ${detail}` : ''}
      </Text>
      <Text size="xs" c="dimmed" mt={4}>
        Catalog extensions are platform releases under change control. The manifest was not modified.
      </Text>
    </Alert>
  );
}
