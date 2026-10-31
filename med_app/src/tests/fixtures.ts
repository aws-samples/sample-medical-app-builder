import { parse as parseYaml } from 'yaml';
import { parseManifestSource, type RegistryEntry } from '../manifest/registry';

/**
 * The hand-authored reference manifests (med_app/fixtures/manifests): what the compiler must reproduce from
 * their specs and what the renderer, dispatcher and lifecycle tests exercise — two roles with inherited scopes,
 * a draft and a version in review, a cohort chain, the first write, an intentionally broken file. They are
 * fixtures, not part of the registry: the launcher and the seed script read med_app/manifests, the showcase set.
 */
const fixtureFiles = import.meta.glob('/fixtures/manifests/*.yaml', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const specFiles = import.meta.glob('/specs/*.yaml', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

export function loadFixtureRegistry(): RegistryEntry[] {
  const specs = new Map<string, Record<string, unknown>>();
  for (const source of Object.values(specFiles)) {
    const spec = parseYaml(source) as { app?: { app_id?: string } } | null;
    if (spec?.app?.app_id) specs.set(spec.app.app_id, spec as Record<string, unknown>);
  }
  return Object.entries(fixtureFiles)
    .map(([file, source]) => parseManifestSource(file.replace(/^\/fixtures\/manifests\//, ''), source))
    .map((e): RegistryEntry => {
      const spec = e.ok ? specs.get(e.manifest.metadata.app_id) : undefined;
      return e.ok && spec ? { ...e, meta: { spec } } : e;
    })
    .sort((a, b) => a.file.localeCompare(b.file));
}
