import { forwardRef, type CSSProperties } from 'react';
import type { LocalClip } from '../bindings';
import { C, formatTime, formatBytes } from '../design';
import { groupByTimeBucket } from '../lib/timeBuckets';
import { SourcePill } from './SourcePill';

interface ClipListProps {
  clips: LocalClip[];
  selected: LocalClip | null;
  onSelect: (clip: LocalClip) => void;
  onCopy: (clip: LocalClip) => void;
  query: string;
  deviceNicknames: Record<string, string>;
  now?: number;
}

export const ClipList = forwardRef<HTMLDivElement, ClipListProps>(
  ({ clips, selected, onSelect, onCopy, query, deviceNicknames, now }, ref) => {
    if (clips.length === 0) {
      return (
        <div style={S.col}>
          <div style={S.empty}>
            <div style={S.emptyTitle}>
              {query ? `No results for "${query}"` : 'No clips yet'}
            </div>
            {!query && (
              <code style={S.emptyHint}>echo "hello" | cinch push</code>
            )}
          </div>
        </div>
      );
    }

    const groups = groupByTimeBucket(clips, now);

    return (
      <div ref={ref} style={S.col} role="list">
        {groups.map(({ bucket, items }) => (
          <section key={bucket}>
            <div style={S.sectionLabel}>{bucket}</div>
            {items.map((clip) => (
              <ClipRow
                key={clip.id}
                clip={clip}
                selected={selected?.id === clip.id}
                onClick={() => onSelect(clip)}
                onDoubleClick={() => onCopy(clip)}
                nickname={deviceNicknames[clip.source]}
              />
            ))}
          </section>
        ))}
      </div>
    );
  }
);

ClipList.displayName = 'ClipList';

interface ClipRowProps {
  clip: LocalClip;
  selected: boolean;
  onClick: () => void;
  onDoubleClick: () => void;
  nickname?: string;
}

function ClipRow({ clip, selected, onClick, onDoubleClick, nickname }: ClipRowProps) {
  const isImage = clip.content_type === 'image' && !!clip.media_path;
  const preview = isImage
    ? `Image (${formatBytes(clip.byte_size)})`
    : clip.content.replace(/\s+/g, ' ').trim().substring(0, 140);
  return (
    <div
      role="button"
      data-id={clip.id}
      aria-selected={selected}
      aria-label={preview || 'empty clip'}
      tabIndex={0}
      style={{ ...S.row, ...(selected ? S.rowActive : {}) }}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
    >
      <span style={S.preview}>{preview || ' '}</span>
      <span style={S.meta}>
        <SourcePill source={clip.source} status={clip.source === 'local' ? 'local' : 'remote'} nickname={nickname} />
        <span style={{ color: C.t4 }}>·</span>
        <span>{formatTime(clip.created_at)}</span>
      </span>
    </div>
  );
}

const S: Record<string, CSSProperties> = {
  col: {
    width: 320,
    flexShrink: 0,
    background: C.card,
    borderRight: `1px solid ${C.border}`,
    overflowY: 'auto',
  },
  sectionLabel: {
    padding: '14px 18px 6px',
    fontFamily: 'var(--font-mono)',
    fontSize: 11,
    fontWeight: 600,
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
    color: C.t2,
  },
  row: {
    padding: '11px 18px',
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
    cursor: 'pointer',
    borderBottom: `1px solid ${C.border}`,
  },
  rowActive: {
    background: C.selected,
  },
  preview: {
    fontSize: 13.5,
    fontFamily: 'var(--font-body)',
    color: C.t1,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    letterSpacing: '-0.005em',
    lineHeight: 1.45,
  },
  meta: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    fontSize: 10.5,
    fontFamily: 'var(--font-mono)',
    letterSpacing: '0.04em',
    color: C.t3,
  },
  empty: {
    padding: '40px 20px',
    textAlign: 'center',
  },
  emptyTitle: { color: C.t2, fontSize: 13, marginBottom: 6 },
  emptyHint: { fontSize: 11, color: C.t3, fontFamily: 'var(--font-mono)' },
};
