import type { LocalClip } from '../bindings';

export const CLIP_FILTERS = ['all', 'text', 'image', 'code', 'url'] as const;

export type ClipFilter = typeof CLIP_FILTERS[number];
export type EditableClipFilter = Exclude<ClipFilter, 'all'>;
export type ClipFilterRules = Record<EditableClipFilter, string[]>;

export const DEFAULT_CLIP_FILTER_RULES: ClipFilterRules = {
  text: ['text', 'json'],
  image: ['image'],
  code: ['code'],
  url: ['url'],
};

export function applyClipFilter(
  clips: LocalClip[],
  filter: ClipFilter,
): LocalClip[] {
  if (filter === 'all') return clips;
  const allowed = new Set(DEFAULT_CLIP_FILTER_RULES[filter]);
  return clips.filter((clip) => allowed.has(clip.content_type));
}
