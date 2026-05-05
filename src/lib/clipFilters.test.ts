import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CLIP_FILTER_RULES,
  applyClipFilter,
  normalizeClipFilterRules,
  parseFilterTypesInput,
} from './clipFilters';
import type { LocalClip } from '../bindings';

const clip = (content_type: string): LocalClip => ({
  id: content_type,
  user_id: 'u',
  content: content_type,
  content_type,
  source: 'local',
  label: '',
  byte_size: content_type.length,
  media_path: null,
  created_at: 1,
  synced: false,
  is_pinned: false,
  pin_note: null,
  received_at: 1,
});

describe('clip filter rules', () => {
  it('keeps the existing default filter behavior', () => {
    const clips = ['text', 'json', 'error', 'image', 'code', 'url'].map(clip);

    expect(applyClipFilter(clips, 'all', DEFAULT_CLIP_FILTER_RULES).map((c) => c.content_type))
      .toEqual(['text', 'json', 'error', 'image', 'code', 'url']);
    expect(applyClipFilter(clips, 'text', DEFAULT_CLIP_FILTER_RULES).map((c) => c.content_type))
      .toEqual(['text', 'json']);
    expect(applyClipFilter(clips, 'image', DEFAULT_CLIP_FILTER_RULES).map((c) => c.content_type))
      .toEqual(['image']);
    expect(applyClipFilter(clips, 'code', DEFAULT_CLIP_FILTER_RULES).map((c) => c.content_type))
      .toEqual(['code']);
    expect(applyClipFilter(clips, 'url', DEFAULT_CLIP_FILTER_RULES).map((c) => c.content_type))
      .toEqual(['url']);
  });

  it('applies user-customized content_type mappings', () => {
    const rules = normalizeClipFilterRules({
      text: ['text', 'json', 'error'],
      image: ['image', 'application/pdf'],
      code: ['code', 'shell'],
      url: ['url', 'deep-link'],
    });
    const clips = ['text', 'error', 'application/pdf', 'shell', 'deep-link'].map(clip);

    expect(applyClipFilter(clips, 'text', rules).map((c) => c.content_type))
      .toEqual(['text', 'error']);
    expect(applyClipFilter(clips, 'image', rules).map((c) => c.content_type))
      .toEqual(['application/pdf']);
    expect(applyClipFilter(clips, 'code', rules).map((c) => c.content_type))
      .toEqual(['shell']);
    expect(applyClipFilter(clips, 'url', rules).map((c) => c.content_type))
      .toEqual(['deep-link']);
  });

  it('parses comma and newline separated type lists', () => {
    expect(parseFilterTypesInput(' text, json\nerror ,, text '))
      .toEqual(['text', 'json', 'error']);
  });
});
