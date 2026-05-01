export const PILL_PALETTE_SIZE = 6;

export interface PillVars {
  bg: string;
  fg: string;
}

/**
 * Maps a clip source key to a CSS variable pair for its pill background and foreground.
 * `local` always returns the neutral pill. Remote sources hash deterministically into
 * one of PILL_PALETTE_SIZE color slots so the same machine always reads in the same color.
 */
export function sourcePillVars(source: string): PillVars {
  if (source === 'local') {
    return { bg: 'var(--pill-local-bg)', fg: 'var(--pill-local-fg)' };
  }
  let hash = 0;
  for (let i = 0; i < source.length; i++) {
    hash = (hash * 31 + source.charCodeAt(i)) >>> 0;
  }
  const slot = (hash % PILL_PALETTE_SIZE) + 1;
  return {
    bg: `var(--pill-${slot}-bg)`,
    fg: `var(--pill-${slot}-fg)`,
  };
}
