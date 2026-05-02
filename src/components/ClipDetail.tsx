import type { CSSProperties } from 'react';
import { useEffect, useState } from 'react';
import type { LocalClip } from '../bindings';
import { C, formatBytes } from '../design';
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
  // Prose for free-form text only; everything technical (code/json/url/error)
  // stays in mono so structure-bearing whitespace and punctuation read correctly.
  const isProse = !isJsonish && clip.content_type === 'text';
  const body = isJsonish ? tryPrettyJson(clip.content) : clip.content;

  const stamp = new Date(clip.created_at * 1000).toLocaleString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });

  return (
    <div style={S.col}>
      <div style={S.header}>
        <div style={S.stamp}>
          <SourcePill source={clip.source} status={clip.source === 'local' ? 'local' : 'remote'} />
          <span style={{ color: C.t4 }}>·</span>
          <span>{stamp}</span>
        </div>
      </div>

      {isImage ? (
        <div style={S.imageStage}>
          <img
            src={`cinch://media/${clip.id}`}
            alt={`Clip from ${clip.source}`}
            style={S.imageFit}
            onLoad={(e) => {
              const img = e.currentTarget;
              if (img.naturalWidth) setImgDims({ w: img.naturalWidth, h: img.naturalHeight });
            }}
          />
        </div>
      ) : (
        <div style={S.scrollArea}>
          {isProse ? (
            <div style={S.prose}>{body}</div>
          ) : (
            <pre style={S.code}>{body}</pre>
          )}
        </div>
      )}

      <div style={S.footer}>
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
    fontSize: 13,
    fontWeight: 500,
    letterSpacing: '-0.005em',
  },
  col: {
    flex: 1,
    minWidth: 0,
    minHeight: 0,
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
    background: C.card,
  },
  header: {
    flexShrink: 0,
    padding: '14px 26px',
    borderBottom: `1px solid ${C.border}`,
    background: C.card,
  },
  scrollArea: {
    flex: 1,
    minHeight: 0,
    overflowY: 'auto',
    padding: '20px 26px 24px',
  },
  footer: {
    flexShrink: 0,
    padding: '14px 26px 18px',
    borderTop: `1px solid ${C.border}`,
    background: C.card,
    display: 'flex',
    flexDirection: 'column',
    gap: 14,
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
  code: {
    background: C.card2,
    border: `1px solid ${C.border}`,
    borderRadius: 6,
    padding: '16px 18px',
    fontFamily: 'var(--font-mono)',
    fontSize: 13,
    lineHeight: 1.6,
    color: C.t1,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    margin: 0,
  },
  prose: {
    fontSize: 14.5,
    lineHeight: 1.65,
    letterSpacing: '-0.005em',
    color: C.t1,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    maxWidth: '68ch',
    margin: 0,
  },
  imageStage: {
    flex: 1,
    minHeight: 0,
    minWidth: 0,
    overflow: 'hidden',
    padding: '20px 26px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  imageFit: {
    display: 'block',
    maxWidth: '100%',
    maxHeight: '100%',
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
