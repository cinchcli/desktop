import type { CSSProperties } from 'react';
import { useEffect, useState } from 'react';
import type { LocalClip } from '../bindings';
import { C, formatBytes } from '../design';
import { clipTitle } from '../lib/clipTitle';
import { SourcePill } from './SourcePill';

interface ClipDetailProps {
  clip: LocalClip | null;
  onCopy: (clip: LocalClip) => void;
  onPin: (clip: LocalClip) => void;
  onDelete: (clip: LocalClip) => void;
}

export function ClipDetail({ clip, onCopy, onPin, onDelete }: ClipDetailProps) {
  const [imgDims, setImgDims] = useState<{ w: number; h: number } | null>(null);
  useEffect(() => { setImgDims(null); }, [clip?.id]);

  if (!clip) {
    return <div style={S.placeholder}>Select a clip</div>;
  }

  const isImage = clip.content_type === 'image' && !!clip.media_path;
  const isJsonish =
    clip.content_type === 'json' ||
    (clip.content.trim().startsWith('{') && clip.content.trim().endsWith('}')) ||
    (clip.content.trim().startsWith('[') && clip.content.trim().endsWith(']'));
  const body = isJsonish ? tryPrettyJson(clip.content) : clip.content;

  const title = clipTitle(clip);
  const stamp = new Date(clip.created_at * 1000).toLocaleString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });

  return (
    <div style={S.col}>
      <div style={S.stamp}>
        <SourcePill source={clip.source} status={clip.source === 'local' ? 'local' : 'remote'} />
        <span style={{ color: C.t4 }}>·</span>
        <span>{stamp}</span>
      </div>

      <h1 style={S.title}>{title}</h1>

      {isImage ? (
        <div style={S.imgFrame}>
          <img
            src={`cinch://media/${clip.id}`}
            alt={`Clip from ${clip.source}`}
            style={S.img}
            onLoad={(e) => {
              const img = e.currentTarget;
              if (img.naturalWidth) setImgDims({ w: img.naturalWidth, h: img.naturalHeight });
            }}
          />
        </div>
      ) : (
        <pre style={S.code}>{body}</pre>
      )}

      <div style={S.actions}>
        <button type="button" onClick={() => onCopy(clip)} style={S.btnPrimary}>
          Copy <span style={S.kbdHint}>↵</span>
        </button>
        <button type="button" onClick={() => onPin(clip)} style={S.btnGhost}>
          {clip.is_pinned ? 'Unpin' : 'Pin'} <span style={S.kbdHint}>⌘P</span>
        </button>
        <button
          type="button"
          onClick={() => onDelete(clip)}
          style={{ ...S.btnGhost, marginLeft: 'auto' }}
        >
          Delete <span style={S.kbdHint}>⌘⌫</span>
        </button>
      </div>

      <dl style={S.metaList}>
        <MetaRow label="Source" value={clip.source.startsWith('remote:') ? clip.source.replace('remote:', '') : clip.source} />
        <MetaRow label="Type" value={clip.content_type} />
        <MetaRow label="Size" value={formatBytes(clip.byte_size)} />
        {isImage && imgDims && <MetaRow label="Dimensions" value={`${imgDims.w} × ${imgDims.h}`} />}
        {clip.is_pinned && <MetaRow label="Note" value={clip.pin_note ?? '(no note)'} />}
      </dl>
    </div>
  );
}

function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt style={S.metaKey}>{label}</dt>
      <dd style={S.metaVal}>{value}</dd>
    </>
  );
}

function tryPrettyJson(s: string): string {
  try { return JSON.stringify(JSON.parse(s), null, 2); } catch { return s; }
}

const S: Record<string, CSSProperties> = {
  placeholder: {
    flex: 1,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: C.t3,
    fontSize: 12,
    fontFamily: 'var(--font-serif)',
    letterSpacing: '-0.01em',
  },
  col: {
    flex: 1,
    minWidth: 0,
    padding: '22px 26px',
    display: 'flex',
    flexDirection: 'column',
    gap: 14,
    overflow: 'auto',
    background: C.card,
  },
  stamp: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    fontSize: 10,
    fontFamily: 'var(--font-mono)',
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
    color: C.t3,
  },
  title: {
    fontFamily: 'var(--font-serif)',
    fontWeight: 400,
    fontSize: 22,
    lineHeight: 1.2,
    letterSpacing: '-0.02em',
    margin: 0,
    color: C.t1,
  },
  code: {
    background: C.card2,
    border: `1px solid ${C.border}`,
    borderRadius: 6,
    padding: '14px 16px',
    fontFamily: 'var(--font-mono)',
    fontSize: 12,
    lineHeight: 1.6,
    color: C.t1,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    margin: 0,
  },
  imgFrame: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: C.card2,
    border: `1px solid ${C.border}`,
    borderRadius: 6,
    padding: 18,
    minHeight: 160,
    width: '100%',
    minWidth: 0,
    boxSizing: 'border-box',
    overflow: 'hidden',
  },
  img: {
    display: 'block',
    maxWidth: '100%',
    maxHeight: '60vh',
    width: 'auto',
    height: 'auto',
    objectFit: 'contain',
    borderRadius: 2,
  },
  actions: { display: 'flex', gap: 8, alignItems: 'center' },
  btnPrimary: {
    padding: '6px 14px',
    background: C.t1,
    color: C.bg,
    border: 'none',
    borderRadius: 5,
    fontFamily: 'inherit',
    fontSize: 12,
    cursor: 'pointer',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
  },
  btnGhost: {
    padding: '6px 14px',
    background: 'transparent',
    color: C.t2,
    border: `1px solid ${C.border}`,
    borderRadius: 5,
    fontFamily: 'inherit',
    fontSize: 12,
    cursor: 'pointer',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
  },
  kbdHint: {
    fontFamily: 'var(--font-mono)',
    fontSize: 10,
    opacity: 0.6,
    letterSpacing: '0.04em',
  },
  metaList: {
    margin: 0,
    marginTop: 'auto',
    paddingTop: 14,
    borderTop: `1px solid ${C.border}`,
    display: 'grid',
    gridTemplateColumns: '80px 1fr',
    rowGap: 5,
    columnGap: 12,
    fontFamily: 'var(--font-mono)',
    fontSize: 11,
  },
  metaKey: {
    color: C.t3,
    letterSpacing: '0.06em',
    textTransform: 'uppercase',
    margin: 0,
  },
  metaVal: { color: C.t1, margin: 0, wordBreak: 'break-all' },
};
