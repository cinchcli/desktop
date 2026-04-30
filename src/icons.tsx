// Inline SVG icons (Phosphor-inspired, 1.75 stroke, currentColor).
// Replaces emoji per DESIGN.md.
import type { CSSProperties, SVGProps, ReactElement } from "react";

type IconProps = { size?: number; style?: CSSProperties };

const base = (size: number): SVGProps<SVGSVGElement> => ({
  width: size,
  height: size,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.75,
  strokeLinecap: "round",
  strokeLinejoin: "round",
});

// ─── UI Icons ─────────────────────────────────────────────

export const IconSearch = ({ size = 14, style }: IconProps) => (
  <svg {...base(size)} style={style}>
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.5-3.5" />
  </svg>
);

export const IconX = ({ size = 12, style }: IconProps) => (
  <svg {...base(size)} style={style}>
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>
);

export const IconCaret = ({ size = 10, style }: IconProps) => (
  <svg {...base(size)} style={style}>
    <path d="m6 9 6 6 6-6" />
  </svg>
);

export const IconCopy = ({ size = 14, style }: IconProps) => (
  <svg {...base(size)} style={style}>
    <rect x="9" y="9" width="11" height="11" rx="2" />
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
  </svg>
);

export const IconTrash = ({ size = 14, style }: IconProps) => (
  <svg {...base(size)} style={style}>
    <path d="M4 7h16M9 7V4h6v3M6 7l1 13a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-13" />
  </svg>
);

export const IconDoc = ({ size = 14, style }: IconProps) => (
  <svg {...base(size)} style={style}>
    <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9l-6-6Z" />
    <path d="M14 3v6h6" />
  </svg>
);

export const IconCode = ({ size = 14, style }: IconProps) => (
  <svg {...base(size)} style={style}>
    <path d="m8 8-5 4 5 4M16 8l5 4-5 4M14 4l-4 16" />
  </svg>
);

export const IconBraces = ({ size = 14, style }: IconProps) => (
  <svg {...base(size)} style={style}>
    <path d="M8 3H7a2 2 0 0 0-2 2v4a2 2 0 0 1-2 2 2 2 0 0 1 2 2v4a2 2 0 0 0 2 2h1M16 3h1a2 2 0 0 1 2 2v4a2 2 0 0 0 2 2 2 2 0 0 0-2 2v4a2 2 0 0 1-2 2h-1" />
  </svg>
);

export const IconLink = ({ size = 14, style }: IconProps) => (
  <svg {...base(size)} style={style}>
    <path d="M10 13a5 5 0 0 0 7.07 0l3-3a5 5 0 0 0-7.07-7.07l-1.5 1.5M14 11a5 5 0 0 0-7.07 0l-3 3a5 5 0 0 0 7.07 7.07l1.5-1.5" />
  </svg>
);

export const IconImage = ({ size = 14, style }: IconProps) => (
  <svg {...base(size)} style={style}>
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <circle cx="9" cy="9" r="2" />
    <path d="m21 15-4-4L5 21" />
  </svg>
);

export const IconAlert = ({ size = 14, style }: IconProps) => (
  <svg {...base(size)} style={style}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 8v5M12 16h.01" />
  </svg>
);

export const IconArrowReturn = ({ size = 12, style }: IconProps) => (
  <svg {...base(size)} style={style}>
    <path d="M20 8v4a2 2 0 0 1-2 2H6m0 0 4-4m-4 4 4 4" />
  </svg>
);

// ─── Theme toggle icons ───────────────────────────────────

export const IconSun = ({ size = 13, style }: IconProps) => (
  <svg {...base(size)} style={style}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
  </svg>
);

export const IconMoon = ({ size = 13, style }: IconProps) => (
  <svg {...base(size)} style={style}>
    <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
  </svg>
);

export const IconGear = ({ size = 13, style }: IconProps) => (
  <svg {...base(size)} style={style}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
  </svg>
);

// ─── Content type icons ──────────────────────────────────

export const IconBinary = ({ size = 14, style }: IconProps) => (
  <svg {...base(size)} style={style}>
    <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9l-6-6Z" />
    <path d="M14 3v6h6" />
    <path d="M9 13h2M13 13h2" />
    <path d="M9 17h2M13 17h2" />
  </svg>
);

export const IconClipboard = ({ size = 14, style }: IconProps) => (
  <svg {...base(size)} style={style}>
    <rect x="8" y="2" width="8" height="4" rx="1" />
    <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
  </svg>
);

export const IconPin = ({ size = 14, style }: IconProps) => (
  <svg {...base(size)} style={style}>
    <path d="M12 2l2.4 6H20l-5 3.6 1.9 6L12 14l-4.9 3.6L9 11.6 4 8h5.6L12 2z" />
  </svg>
);

export const IconAutoCopy = ({ size = 14, style }: IconProps) => (
  <svg {...base(size)} style={style}>
    <rect x="8" y="2" width="8" height="4" rx="1" />
    <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
    <path d="M12 10v6M9.5 13.5 12 16l2.5-2.5" />
  </svg>
);

// ─── Type glyph map ───────────────────────────────────────

export function typeGlyph(t: string, size = 14): ReactElement {
  switch (t) {
    case "code":  return <IconCode size={size} />;
    case "json":  return <IconBraces size={size} />;
    case "url":   return <IconLink size={size} />;
    case "image": return <IconImage size={size} />;
    case "error": return <IconAlert size={size} />;
    default:      return <IconDoc size={size} />;
  }
}
