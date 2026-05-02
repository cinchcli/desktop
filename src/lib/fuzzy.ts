import uFuzzy from '@leeoniya/ufuzzy';
import type { LocalClip } from '../bindings';

export interface FuzzyTarget {
  clip: LocalClip;
  haystack: string;
}

const FROM_TOKEN_RE = /\bfrom:(\S+)/i;

export interface ParsedQuery {
  from: string | null;
  residual: string;
}

export function parseFromToken(query: string): ParsedQuery {
  const m = query.match(FROM_TOKEN_RE);
  if (!m) return { from: null, residual: query.trim() };
  const residual = query.replace(FROM_TOKEN_RE, ' ').replace(/\s+/g, ' ').trim();
  return { from: m[1], residual };
}

export function buildTargets(
  clips: LocalClip[],
  nicknameBySource: Record<string, string>,
  includePinNote = false,
): FuzzyTarget[] {
  return clips.map((clip) => {
    const nickname = nicknameBySource[clip.source] ?? '';
    const sourceTail = clip.source.startsWith('remote:')
      ? clip.source.slice('remote:'.length)
      : clip.source;
    const note = includePinNote && clip.pin_note ? clip.pin_note : '';
    return {
      clip,
      haystack: [clip.content, nickname, sourceTail, note]
        .filter((s) => s.length > 0)
        .join('  '),
    };
  });
}

const fuzz = new uFuzzy({
  intraMode: 1, // tolerate one typo per term
  intraIns: 1,  // one skipped char per term (fzf-lite)
});

export function fuzzySearch(targets: FuzzyTarget[], query: string): LocalClip[] {
  const trimmed = query.trim();
  if (!trimmed) return targets.map((t) => t.clip);

  const haystacks = targets.map((t) => t.haystack);
  const idxs = fuzz.filter(haystacks, trimmed);
  if (!idxs || idxs.length === 0) return [];

  const info = fuzz.info(idxs, haystacks, trimmed);
  const order = fuzz.sort(info, haystacks, trimmed);
  return order.map((rank) => targets[info.idx[rank]].clip);
}
