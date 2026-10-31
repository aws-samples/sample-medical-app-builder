import { parse as parseYaml } from 'yaml';
import catalogYaml from '../../../docs/application-catalog.yaml?raw';

/**
 * What to try first. The empty composer offers a handful of requests a clinician can send with one click — the
 * same example requests the application catalog gives the assistant (docs/application-catalog.yaml,
 * `archetypes[].example_requests`), so what is offered is exactly what the assistant was taught to build, in both
 * languages, and a new archetype's examples appear here without a second list to maintain.
 */

export type StarterLanguage = 'en' | 'de';

export interface StarterPrompt {
  readonly archetype: string;
  /** The archetype's name — the kind of app the request leads to. */
  readonly kind: string;
  readonly text: string;
}

/** The four shown first: a trend, a form designed in the conversation, a cohort narrowed by imaging, a composed page. */
const FEATURED: readonly { archetype: string; example: number }[] = [
  { archetype: 'APP-02', example: 0 },
  { archetype: 'APP-11', example: 2 },
  { archetype: 'APP-09', example: 2 },
  { archetype: 'APP-12', example: 0 },
];

interface CatalogArchetype {
  readonly id: string;
  readonly name: string;
  readonly example_requests: Readonly<Record<string, readonly string[]>>;
}

let archetypes: readonly CatalogArchetype[] | undefined;

function catalog(): readonly CatalogArchetype[] {
  if (!archetypes) {
    const doc = parseYaml(catalogYaml) as { archetypes: CatalogArchetype[] };
    archetypes = doc.archetypes;
  }
  return archetypes;
}

function prompt(a: CatalogArchetype, language: StarterLanguage, example: number): StarterPrompt | undefined {
  const texts = a.example_requests[language] ?? a.example_requests['en'] ?? [];
  const text = texts[example] ?? texts[0];
  return text ? { archetype: a.id, kind: a.name, text } : undefined;
}

/** The featured requests, then one for every other archetype in catalog order. */
export function starterPrompts(language: StarterLanguage): { featured: StarterPrompt[]; more: StarterPrompt[] } {
  const all = catalog();
  const byId = new Map(all.map((a) => [a.id, a]));
  const featured = FEATURED.map((f) => {
    const a = byId.get(f.archetype);
    return a && prompt(a, language, f.example);
  }).filter((p): p is StarterPrompt => Boolean(p));
  const shown = new Set(featured.map((p) => p.archetype));
  const more = all.filter((a) => !shown.has(a.id)).map((a) => prompt(a, language, 0)).filter((p): p is StarterPrompt => Boolean(p));
  return { featured, more };
}
