# Media

The README's screenshots and the composer video, taken from the panel in mock mode with the shipped hospital's branding
(Klinikum Musterstadt) and the synthetic record — nothing in AWS, no real person.

| File | What |
|---|---|
| `composer-replay.gif` · `composer-replay.mp4` | The drafting page replaying a recorded session (`VITE_AGENT_MODE=replay`): the assistant's replies and tool calls are the model's own, from a session against the synthetic record (`med_app/src/authoring/replay/bp-trend.json`); three turns, then the compiled preview |
| `launcher.png`, `app-*.png`, `review.png`, `users.png`, `audit.png`, `catalog.png`, `shapes.png`, `sign-in.png`, `drafting-preview.png` | The pages the README shows |
| `scripts/record_composer.py`, `scripts/screenshots.py` | How they were made (Playwright against the dev server); each script's docstring has the commands |
| `scripts/wordmark.py` | Generates the sample hospital's logo SVGs (`infra/hospitals/hsp-musterstadt/logo*.svg`): the name set in Geist and outlined, in a box that fits it |

To regenerate: `cd med_app`, a `.env` with `VITE_AUTH_MODE=mock`, `VITE_REGISTRY_MODE=local`, `VITE_DATA_MODE=mock`,
`VITE_HOSPITAL_ID=hsp-musterstadt`, `VITE_AGENT_MODE=replay` and the hospital's `VITE_BRANDING` (single-quoted JSON, see the
root README), the logo SVGs copied to `public/branding/`, `npm run dev`, then the two scripts.
