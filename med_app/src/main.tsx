import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import '@mantine/core/styles.css';
import '@medplum/react/styles.css';
import './styles.css';
import { resolveBranding } from './branding';
import { fetchRuntimeOverrides, initRuntimeConfig } from './config/env';
import { applyBranding } from './theme';

// The deployment's config.json (if any) must be in place before the app module is evaluated: App.tsx builds
// its auth provider and API clients from `runtimeConfig` at import time. Hence the dynamic import.
async function boot(): Promise<void> {
  const config = initRuntimeConfig(await fetchRuntimeOverrides());
  // The hospital's colours and logo (config.json → VITE_BRANDING, over the defaults of src/branding.ts): the CSS
  // variables styles.css reads, the tokens and the Mantine theme — written before anything renders.
  applyBranding(document.documentElement, resolveBranding(config.branding));
  const { default: App } = await import('./App');
  createRoot(document.getElementById('root') as HTMLElement).render(
    <StrictMode>
      <App />
    </StrictMode>
  );
}

void boot();
