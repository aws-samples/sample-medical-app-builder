/**
 * Badges inside table cells: Mantine's badge label is a flex item that may shrink to an ellipsis when
 * the table's auto layout squeezes its column — a long description beside it, or a narrow column in a
 * composed page. Letting the label overflow restores its intrinsic width, so the cell keeps the whole
 * word ("active", "in review") and the wider text columns yield instead.
 */
export const KEEP_WHOLE = { root: { overflow: 'visible' as const, maxWidth: 'none' }, label: { overflow: 'visible' as const, textOverflow: 'clip' as const } };

/** The cell around such a badge: never wrap, never shrink below the badge. */
export const BADGE_CELL = { whiteSpace: 'nowrap' as const };
