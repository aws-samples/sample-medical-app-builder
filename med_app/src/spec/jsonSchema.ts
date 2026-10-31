import { z } from 'zod';
import { AppSpecSchema } from './appSpec';

/**
 * The AppSpec as JSON Schema — for the Python agent's tools and for anyone else that must produce a
 * spec without importing this code. `io: 'input'`: fields with defaults are optional on the way in.
 * Written to docs/app-spec.schema.json by `scripts/appspec.mjs schema`; a test guards against drift.
 */
export function appSpecJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(AppSpecSchema, { io: 'input', unrepresentable: 'any', target: 'draft-2020-12' }) as Record<string, unknown>;
}
