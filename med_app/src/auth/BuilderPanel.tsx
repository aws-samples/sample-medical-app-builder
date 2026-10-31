import { Stack, Text } from '@mantine/core';
import { currentBranding, scales, tokens } from '../theme';

/**
 * Brand panel of the sign-in screen. Shows the one thing this product does — a clinician's
 * request becoming a reviewed, published clinical app — as a quiet illustration, with the
 * hospital this deployment belongs to (its logo too, given a light variant in its branding).
 * No infrastructure detail belongs here. Every colour is the palette's: the illustration is
 * drawn in the ink scale, the accent and the chart colours, so a re-coloured deployment keeps it.
 */
export function BuilderPanel({ hospitalName }: { hospitalName: string }) {
  // The hospital's logo, when the deployment gave a light variant for this dark panel (src/branding.ts, or config.json).
  const logo = currentBranding().logo;
  return (
    <div className="signin-brand">
      <Stack gap={6}>
        <div className="signin-wordmark">
          <BuilderMark />
          <Text fw={600} c={tokens.surface} size="md">
            Medical app builder
          </Text>
        </div>
        {logo?.srcOnDark && <img className="signin-logo" src={logo.srcOnDark} alt={logo.alt} style={{ height: (logo.height ?? 28) * 1.5 }} data-testid="signin-logo" />}
        {!(logo?.srcOnDark && logo.hideName) && (
          <Text className="signin-hospital" c={tokens.surface} fw={600}>
            {hospitalName}
          </Text>
        )}
        <Text size="sm" c={scales.ink[3]} maw={420}>
          Clinical apps described in plain language, reviewed by clinicians, and rendered from validated building blocks.
        </Text>
      </Stack>

      <HeroIllustration />

      <ol className="signin-steps">
        <li>
          <span>Describe</span>
          <Text size="sm" c={scales.ink[3]}>
            A clinician says what the app should show, in their own words.
          </Text>
        </li>
        <li>
          <span>Review</span>
          <Text size="sm" c={scales.ink[3]}>
            A clinical reviewer checks it against the hospital's requirements and signs it off.
          </Text>
        </li>
        <li>
          <span>Publish</span>
          <Text size="sm" c={scales.ink[3]}>
            The app appears for the people it is meant for, with the data they are allowed to see.
          </Text>
        </li>
      </ol>
    </div>
  );
}

function BuilderMark() {
  return (
    <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden focusable="false">
      <rect x="1" y="5" width="14" height="14" rx="3" fill="none" stroke={tokens.accent} strokeWidth="1.6" />
      <rect x="7" y="1" width="14" height="14" rx="3" fill={tokens.ink} stroke={scales.ink[4]} strokeWidth="1.6" />
      <path d="M10.5 8h7M14 4.5v7" stroke={tokens.line} strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

/** A request on the left, the rendered app on the right. Everything is drawn; no images. */
function HeroIllustration() {
  const systolic = [156, 157, 149, 154, 156, 147, 153, 149, 148, 155, 149, 154, 145, 143, 147, 146, 147, 143, 136, 138, 143, 133, 141, 135];
  const diastolic = [96, 91, 91, 95, 94, 92, 96, 96, 91, 96, 96, 94, 91, 87, 91, 86, 86, 91, 88, 87, 91, 86, 88, 83];
  const chart = { x: 300, y: 118, w: 190, h: 88, min: 78, max: 162 };
  const px = (i: number) => chart.x + 8 + (i / (systolic.length - 1)) * (chart.w - 16);
  const py = (v: number) => chart.y + chart.h - 8 - ((v - chart.min) / (chart.max - chart.min)) * (chart.h - 16);
  const line = (vals: number[]) => vals.map((v, i) => `${px(i).toFixed(1)},${py(v).toFixed(1)}`).join(' ');

  return (
    <svg className="signin-hero" viewBox="0 0 520 330" role="img" aria-label="A clinician's request being rendered as a clinical app">
      {/* the request */}
      <g>
        <rect x="14" y="58" width="212" height="132" rx="14" fill="var(--ds-ink-raised)" stroke="var(--ds-ink-rule)" />
        {/* avatar: a simple head-and-shoulders silhouette, clipped to the circle */}
        <clipPath id="signin-avatar">
          <circle cx="40" cy="84" r="12" />
        </clipPath>
        <circle cx="40" cy="84" r="12" fill="var(--ds-ink-rule)" />
        <g clipPath="url(#signin-avatar)">
          <circle cx="40" cy="80" r="4.6" fill={scales.ink[2]} />
          <path d="M28 100 C 29 90.5, 34 87.5, 40 87.5 C 46 87.5, 51 90.5, 52 100 Z" fill={scales.ink[2]} />
        </g>
        <circle cx="40" cy="84" r="12" fill="none" stroke={scales.ink[6]} strokeWidth="1" />
        <text x="58" y="88" fontSize="11" fontWeight="600" fill={tokens.line}>
          Dr. Hoffmann
        </text>
        <text x="58" y="101" fontSize="9" fill={scales.ink[4]}>
          Kardiologie
        </text>
        <text fontSize="11.5" fill={tokens.line}>
          <tspan x="30" y="128">
            Show blood pressure over the last
          </tspan>
          <tspan x="30" y="145">
            two years, with the Stage 1
          </tspan>
          <tspan x="30" y="162">
            hypertension thresholds.
          </tspan>
        </text>
      </g>

      {/* from request to app */}
      <path d="M226 124 C 250 124, 254 96, 282 96" fill="none" stroke={tokens.muted} strokeWidth="1.5" strokeDasharray="4 4" />
      <path d="M278 91 L 284 96 L 278 101" fill="none" stroke={tokens.muted} strokeWidth="1.5" />

      {/* the rendered app */}
      <g>
        <rect x="284" y="20" width="222" height="292" rx="14" fill={tokens.page} />
        <text x="300" y="47" fontSize="11" fontWeight="600" fill={tokens.ink}>
          Blood pressure trend
        </text>
        <rect x="300" y="53" width="48" height="4" rx="2" fill={scales.clinical[0]} />
        <rect x="300" y="53" width="24" height="4" rx="2" fill={tokens.accent} opacity="0.9" />
        <rect x="446" y="34" width="44" height="16" rx="8" fill={scales.clinical[0]} />
        <text x="468" y="45" fontSize="8" fontWeight="600" fill={tokens.accent} textAnchor="middle">
          live
        </text>

        <rect x="300" y="60" width="190" height="42" rx="8" fill={tokens.surface} stroke="var(--ds-line-soft)" />
        <circle cx="318" cy="81" r="10" fill={tokens.line} />
        <text x="318" y="84.5" fontSize="8" fontWeight="600" fill={tokens.muted} textAnchor="middle">
          AK
        </text>
        <text x="334" y="78" fontSize="9.5" fontWeight="600" fill={tokens.ink}>
          A. Krüger
        </text>
        <text x="334" y="91" fontSize="8.5" fill={tokens.muted}>
          68 y · MRN KMS-0048213
        </text>

        <rect x={chart.x} y={chart.y} width={chart.w} height={chart.h} rx="8" fill={tokens.surface} stroke="var(--ds-line-soft)" />
        <line x1={chart.x + 8} x2={chart.x + chart.w - 8} y1={py(140)} y2={py(140)} stroke={tokens.alert} strokeWidth="1" strokeDasharray="3 3" />
        <line x1={chart.x + 8} x2={chart.x + chart.w - 8} y1={py(90)} y2={py(90)} stroke={tokens.alert} strokeWidth="1" strokeDasharray="3 3" opacity="0.7" />
        <polyline points={line(systolic)} fill="none" stroke={tokens.data} strokeWidth="1.6" strokeLinejoin="round" />
        <polyline points={line(diastolic)} fill="none" stroke={tokens.data2} strokeWidth="1.6" strokeLinejoin="round" />

        <rect x="300" y="222" width="190" height="74" rx="8" fill={tokens.surface} stroke="var(--ds-line-soft)" />
        {[
          ['9/4/2026', '135/83 mmHg'],
          ['8/7/2026', '141/86 mmHg'],
          ['7/6/2026', '133/85 mmHg'],
        ].map(([date, value], i) => (
          <g key={date}>
            <text x="312" y={241 + i * 22} fontSize="8.5" fill={tokens.muted}>
              {date}
            </text>
            <text x="478" y={241 + i * 22} fontSize="8.5" fontWeight="600" fill={tokens.ink} textAnchor="end">
              {value}
            </text>
            {i < 2 && <line x1="312" x2="478" y1={249 + i * 22} y2={249 + i * 22} stroke={tokens.grid} />}
          </g>
        ))}
      </g>
    </svg>
  );
}
