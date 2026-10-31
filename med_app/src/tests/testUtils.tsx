import type { ReactNode } from 'react';
import { MantineProvider } from '@mantine/core';
import { MedplumProvider } from '@medplum/react-hooks';
import type { MockClient } from '@medplum/mock';
import { render, type RenderResult } from '@testing-library/react';
import { loadRuntimeConfig, type RuntimeConfig } from '../config/env';
import { theme } from '../theme';
import { createSeededMockClient, ensureFhirDefinitions } from '../medplum/MedplumShell';
import { MockPrimitiveExecutor } from '../primitives/data/mock/mockExecutor';
import { ManifestApp, type ManifestAppProps } from '../renderer/ManifestApp';
import type { AppManifest } from '../manifest/schema';
import { SEED_ANCHOR } from '../primitives/data/mock/seed';

export const testConfig: RuntimeConfig = loadRuntimeConfig({
  VITE_HOSPITAL_ID: 'hsp-test',
  VITE_AUTH_MODE: 'mock',
  VITE_DATA_MODE: 'mock',
});

let clientPromise: Promise<MockClient> | null = null;

export async function testMedplum(): Promise<MockClient> {
  await ensureFhirDefinitions();
  clientPromise ??= createSeededMockClient();
  return clientPromise;
}

/** Zero-latency executor whose clock is pinned to the seed anchor so `now-2y` windows are stable. */
export const testExecutor = new MockPrimitiveExecutor(undefined, SEED_ANCHOR, 0);

export function Providers({ medplum, children }: { medplum: MockClient; children: ReactNode }) {
  return (
    <MantineProvider theme={theme}>
      <MedplumProvider medplum={medplum}>{children}</MedplumProvider>
    </MantineProvider>
  );
}

export async function renderManifest(
  manifest: AppManifest,
  overrides: Partial<Omit<ManifestAppProps, 'manifest'>> = {}
): Promise<RenderResult> {
  const medplum = await testMedplum();
  return render(
    <Providers medplum={medplum}>
      <ManifestApp
        manifest={manifest}
        role={overrides.role ?? manifest.auth.default_role}
        context={overrides.context ?? { patient_id: 'pat-kms-0001' }}
        executor={overrides.executor ?? testExecutor}
        config={overrides.config ?? testConfig}
        identity={overrides.identity ?? { sub: 'test-sub', idToken: 'test-token' }}
        onAudit={overrides.onAudit}
        onDiagnostic={overrides.onDiagnostic}
      />
    </Providers>
  );
}
