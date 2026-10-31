import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Center, Loader, Stack, Text } from '@mantine/core';
import { MedplumClient, indexStructureDefinitionBundle, isDataTypeLoaded } from '@medplum/core';
import type { Bundle } from '@medplum/fhirtypes';
import { MockClient } from '@medplum/mock';
import { MedplumProvider } from '@medplum/react-hooks';
import type { RuntimeConfig } from '../config/env';
import { allSeedResources } from '../primitives/data/mock/seed';

let definitionsIndexed: Promise<void> | null = null;

/**
 * Medplum React components render from indexed StructureDefinitions. We index a curated,
 * stripped base-R4 bundle once at startup (see scripts/extract-fhir-definitions.mjs) so
 * rendering never depends on a schema round-trip — there is no Medplum server behind this app.
 */
export function ensureFhirDefinitions(): Promise<void> {
  if (isDataTypeLoaded('Patient') && isDataTypeLoaded('ImagingStudy')) return Promise.resolve();
  definitionsIndexed ??= import('../fhir/base-definitions.json').then((mod) => {
    indexStructureDefinitionBundle((mod.default ?? mod) as unknown as Bundle);
  });
  return definitionsIndexed;
}

/** In mock mode the client is an in-browser FHIR server seeded with the synthetic Musterstadt patients. */
export async function createSeededMockClient(): Promise<MockClient> {
  const client = new MockClient({ seedDefaultData: false });
  for (const resource of allSeedResources()) {
    await client.createResource(resource);
  }
  return client;
}

/**
 * In dispatcher mode Medplum components must not fetch on their own; all data arrives through
 * primitives. The client exists only to satisfy the provider contract. Its fetch is a guard
 * that surfaces any accidental direct call instead of letting it reach a FHIR server.
 */
export function createDispatcherClient(config: RuntimeConfig, getIdToken: () => Promise<string | undefined> | string | undefined): MedplumClient {
  return new MedplumClient({
    baseUrl: `${config.data.apiBaseUrl}/`,
    fhirUrlPath: 'fhir/R4/',
    fetch: async (url: string, init?: RequestInit) => {
      // eslint-disable-next-line no-console
      console.warn(`[med_app] blocked direct FHIR call from a component: ${url} — route it through a primitive.`);
      void init;
      void getIdToken;
      return new Response(JSON.stringify({ resourceType: 'OperationOutcome', issue: [{ severity: 'error', code: 'forbidden', diagnostics: 'Direct FHIR access is not permitted; use a data primitive.' }] }), {
        status: 403,
        headers: { 'content-type': 'application/fhir+json' },
      });
    },
  });
}

export function MedplumShell({ config, getIdToken, children }: { config: RuntimeConfig; getIdToken: () => Promise<string | undefined> | string | undefined; children: ReactNode }) {
  const [client, setClient] = useState<MedplumClient | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mode = config.data.mode;

  const dispatcherClient = useMemo(() => (mode === 'dispatcher' ? createDispatcherClient(config, getIdToken) : null), [mode, config, getIdToken]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await ensureFhirDefinitions();
        const c = mode === 'mock' ? await createSeededMockClient() : dispatcherClient;
        if (!cancelled) setClient(c);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [mode, dispatcherClient]);

  if (error) {
    return (
      <Center h="100vh">
        <Text c="red">Could not initialise the FHIR component layer: {error}</Text>
      </Center>
    );
  }
  if (!client) {
    return (
      <Center h="100vh">
        <Stack align="center" gap="xs">
          <Loader size="sm" />
          <Text size="sm" c="dimmed">
            Loading FHIR definitions{mode === 'mock' ? ' and synthetic patients' : ''}…
          </Text>
        </Stack>
      </Center>
    );
  }
  return <MedplumProvider medplum={client}>{children}</MedplumProvider>;
}
