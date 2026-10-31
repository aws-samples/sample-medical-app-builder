import { useCallback, useMemo, useRef } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { Alert, Button, Center, Container, Loader, MantineProvider, Stack, Text } from '@mantine/core';
import { runtimeConfig } from './config/env';
import { theme } from './theme';
import { AuthProviderBoundary, useAuth } from './auth/AuthContext';
import { displayNameOf } from './auth/types';
import { createCognitoAuthProvider } from './auth/cognito';
import { createMockAuthProvider } from './auth/mockAuth';
import { RequireAuth } from './auth/RequireAuth';
import { MedplumShell } from './medplum/MedplumShell';
import { findEntry, loadRegistry, localRegistrySource, remoteRegistrySource } from './manifest/registry';
import { useRegistry } from './manifest/useRegistry';
import { MockPrimitiveExecutor } from './primitives/data/mock/mockExecutor';
import { DispatcherPrimitiveExecutor } from './primitives/data/dispatcherExecutor';
import { localAuthoringClient, LocalRegistryStore, remoteAuthoringClient, replayAgent, type AuthoringClient, type ReplayScript } from './authoring';
import bpTrendSession from './authoring/replay/bp-trend.json';
import { localUsersClient, remoteUsersClient, type UsersClient } from './users';
import { LocalAuditStore, localAuditClient, remoteAuditClient, type AuditClient } from './audit';
import { localCollectionsClient, remoteCollectionsClient, type CollectionsClient } from './collections';
import { localShapesClient, publishedArtifacts, remoteShapesClient, type ShapesClient } from './shapes';
import { canAuthor, canCurate, isAdmin } from './manifest/roles';
import type { AuditRecord } from './primitives/data/types';
import { AppLauncher } from './panel/AppLauncher';
import { AppRuntime } from './panel/AppRuntime';
import { AuditPage } from './panel/AuditPage';
import { ReviewPage } from './panel/ReviewPage';
import { CatalogPage } from './panel/CatalogPage';
import { DraftingPage, NewDraft } from './panel/DraftingPage';
import { UsersPage } from './panel/UsersPage';
import { ShapesPage } from './panel/shapes/ShapesPage';
import { ShapeEditorPage } from './panel/shapes/ShapeEditorPage';
import { TopBar } from './panel/TopBar';
import { UpdateNotice } from './panel/UpdateNotice';

const authProvider =
  runtimeConfig.auth.mode === 'mock'
    ? createMockAuthProvider()
    : createCognitoAuthProvider({ userPoolId: runtimeConfig.auth.userPoolId || 'unset_unset', clientId: runtimeConfig.auth.clientId || 'unset' });

const mockExecutor = runtimeConfig.data.mode === 'mock' ? new MockPrimitiveExecutor() : null;

// Apps authored in mock mode land here (and survive a reload through sessionStorage); the local
// registry source lists them next to the bundled manifests. Remote mode writes to the real registry.
const localAuthored = runtimeConfig.registry.mode === 'local' ? new LocalRegistryStore(typeof sessionStorage === 'undefined' ? undefined : sessionStorage) : undefined;

// Without a deployed API the audit trail is kept here: what the apps opened in this browser do, over a few samples.
// With one, the dispatcher and the other Lambdas write the trail themselves and the panel only reads it.
const localAudit = runtimeConfig.registry.mode === 'local' ? new LocalAuditStore(typeof sessionStorage === 'undefined' ? undefined : sessionStorage) : undefined;

function SignedInApp() {
  // `getIdToken` is stable and refreshes the token when it is about to expire, so the clients built
  // from it are created once and never send a stale token.
  const { session, getIdToken } = useAuth();

  const executor = useMemo(() => mockExecutor ?? new DispatcherPrimitiveExecutor(runtimeConfig.data.apiBaseUrl, undefined, getIdToken), [getIdToken]);
  // A stable function: the picker fetches the record's first page when this changes, so it must not change per render.
  const searchPatients = useMemo(() => (executor.kind === 'dispatcher' ? (name: string) => executor.searchPatients(name) : undefined), [executor]);

  const source = useMemo(
    () => (runtimeConfig.registry.mode === 'remote' ? remoteRegistrySource(runtimeConfig.data.apiBaseUrl, getIdToken) : localRegistrySource(localAuthored)),
    [getIdToken]
  );
  const registry = useRegistry(source);

  const subRef = useRef(session?.claims.sub ?? '');
  subRef.current = session?.claims.sub ?? '';
  const claimsRef = useRef(session?.claims);
  claimsRef.current = session?.claims;

  // The record-shape library — what a composed page's `record` section writes with. The registry API, or the browser in
  // mock mode (the bundled shapes, published). Its published artifacts go with every compile, so `shape: <id>` resolves.
  const shapes: ShapesClient = useMemo(
    () =>
      runtimeConfig.registry.mode === 'remote'
        ? remoteShapesClient(runtimeConfig.data.apiBaseUrl, getIdToken)
        : localShapesClient({
            caller: () => (claimsRef.current ? { sub: claimsRef.current.sub, email: claimsRef.current.email, name: claimsRef.current.name } : undefined),
            mayAuthor: () => runtimeConfig.auth.mode === 'mock' || (claimsRef.current ? canAuthor(claimsRef.current) : false),
            mayCurate: () => runtimeConfig.auth.mode === 'mock' || (claimsRef.current ? canCurate(claimsRef.current) : false),
            mayAdmin: () => runtimeConfig.auth.mode === 'mock' || (claimsRef.current ? isAdmin(claimsRef.current) : false),
            storage: typeof sessionStorage === 'undefined' ? undefined : sessionStorage,
          }),
    [getIdToken]
  );
  const publishedShapes = useCallback(() => shapes.list().then(publishedArtifacts), [shapes]);

  // The authoring loop: the deployed API when there is one, otherwise the same operations in the browser.
  const authoring: AuthoringClient = useMemo(
    () =>
      runtimeConfig.registry.mode === 'remote'
        ? remoteAuthoringClient(runtimeConfig.data.apiBaseUrl, getIdToken, undefined, { shapes: publishedShapes })
        : localAuthoringClient({
            hospitalId: runtimeConfig.hospitalId,
            getCallerSub: () => subRef.current,
            getCallerIdentity: () => (claimsRef.current ? { name: displayNameOf(claimsRef.current), email: claimsRef.current.email } : undefined),
            registry: localAuthored ?? new LocalRegistryStore(),
            storage: typeof sessionStorage === 'undefined' ? undefined : sessionStorage,
            knownVersions: (appId) => findEntry(loadRegistry(), appId)?.manifest.metadata.version,
            shapes: publishedShapes,
            // No model in mock mode; VITE_AGENT_MODE=replay plays a recorded session back instead (src/authoring/replayAgent.ts).
            ...(runtimeConfig.registry.agent === 'replay' ? { agent: replayAgent(bpTrendSession as ReplayScript) } : {}),
          }),
    [getIdToken, publishedShapes]
  );

  // User administration: the deployed API where there is one; in the browser otherwise, over seeded accounts, so the
  // administrator's section can be tried in mock mode (sign in as `name+medapp-admins`).
  const registryRef = useRef(registry.entries);
  registryRef.current = registry.entries;
  const users: UsersClient = useMemo(
    () =>
      runtimeConfig.registry.mode === 'remote'
        ? remoteUsersClient(runtimeConfig.data.apiBaseUrl, getIdToken)
        : localUsersClient({
            registry: () => registryRef.current,
            caller: () => (claimsRef.current ? { sub: claimsRef.current.sub, email: claimsRef.current.email, name: claimsRef.current.name } : undefined),
            storage: typeof sessionStorage === 'undefined' ? undefined : sessionStorage,
          }),
    [getIdToken]
  );

  // The hospital's collections — how it groups its apps for the launcher: the registry API, or the browser in mock mode.
  const collections: CollectionsClient = useMemo(
    () =>
      runtimeConfig.registry.mode === 'remote'
        ? remoteCollectionsClient(runtimeConfig.data.apiBaseUrl, getIdToken)
        : localCollectionsClient({
            knownAppIds: () => registryRef.current.filter((e) => e.ok).map((e) => (e.ok ? e.manifest.metadata.app_id : '')),
            caller: () => (claimsRef.current ? { sub: claimsRef.current.sub, email: claimsRef.current.email, name: claimsRef.current.name } : undefined),
            mayCurate: () => runtimeConfig.auth.mode === 'mock' || (claimsRef.current ? canCurate(claimsRef.current) : false),
            storage: typeof sessionStorage === 'undefined' ? undefined : sessionStorage,
          }),
    [getIdToken]
  );

  // The audit trail, for administrators: the deployed API reads what the Lambdas wrote; in the browser, the local store.
  const audit: AuditClient = useMemo(
    () => (runtimeConfig.registry.mode === 'remote' ? remoteAuditClient(runtimeConfig.data.apiBaseUrl, getIdToken) : localAuditClient(localAudit ?? new LocalAuditStore())),
    [getIdToken]
  );
  const keepAudit = useCallback((r: AuditRecord) => {
    const claims = claimsRef.current;
    if (localAudit && claims) localAudit.record(r, { sub: claims.sub, name: displayNameOf(claims), email: claims.email });
  }, []);

  if (registry.status === 'loading' && registry.entries.length === 0) {
    return (
      <>
        <TopBar />
        <Center mih="60vh">
          <Stack align="center" gap="xs">
            <Loader size="sm" />
            <Text size="sm" c="dimmed">
              Loading the hospital's app registry...
            </Text>
          </Stack>
        </Center>
      </>
    );
  }

  if (registry.status === 'error' && registry.entries.length === 0) {
    return (
      <>
        <TopBar />
        <Container size="sm" py="xl">
          <Alert color="red" title="The app registry could not be loaded" variant="light">
            <Stack gap="sm">
              <Text size="sm">{registry.error}</Text>
              <Text size="xs" c="dimmed">
                Source: {source.kind === 'remote' ? `${runtimeConfig.data.apiBaseUrl}/registry/apps` : 'bundled manifests'}
              </Text>
              <Button size="xs" variant="light" onClick={registry.reload} w="fit-content">
                Try again
              </Button>
            </Stack>
          </Alert>
        </Container>
      </>
    );
  }

  return (
    <MedplumShell config={runtimeConfig} getIdToken={getIdToken}>
      <Routes>
        <Route path="/" element={<AppLauncher registry={registry.entries} config={runtimeConfig} authoring={authoring} onRegistryChanged={registry.reload} searchPatients={searchPatients} collections={collections} />} />
        <Route path="/catalog" element={<CatalogPage config={runtimeConfig} />} />
        <Route path="/shapes" element={<ShapesPage client={shapes} config={runtimeConfig} />} />
        <Route path="/shapes/new" element={<ShapeEditorPage client={shapes} config={runtimeConfig} />} />
        <Route path="/shapes/:shapeId" element={<ShapeEditorPage client={shapes} config={runtimeConfig} />} />
        <Route path="/users" element={<UsersPage client={users} registry={registry.entries} config={runtimeConfig} />} />
        <Route path="/audit" element={<AuditPage client={audit} users={users} registry={registry.entries} config={runtimeConfig} />} />
        <Route path="/apps/:appId/:version/review" element={<ReviewPage registry={registry.entries} registryLoading={registry.status === 'loading'} config={runtimeConfig} authoring={authoring} onRegistryChanged={registry.reload} />} />
        <Route
          path="/apps/:appId/:version?"
          element={<AppRuntime registry={registry.entries} registryLoading={registry.status === 'loading'} config={runtimeConfig} executor={executor} authoring={authoring} onRegistryChanged={registry.reload} onAudit={keepAudit} />}
        />
        <Route path="/drafts/new" element={<NewDraft client={authoring} registry={registry.entries} shapes={shapes} />} />
        <Route path="/drafts/:draftId" element={<DraftingPage client={authoring} registry={registry.entries} config={runtimeConfig} onRegistryChanged={registry.reload} />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </MedplumShell>
  );
}

export default function App() {
  return (
    <MantineProvider theme={theme}>
      <AuthProviderBoundary provider={authProvider}>
        <BrowserRouter>
          <RequireAuth config={runtimeConfig}>
            <SignedInApp />
          </RequireAuth>
        </BrowserRouter>
      </AuthProviderBoundary>
      <UpdateNotice />
    </MantineProvider>
  );
}
