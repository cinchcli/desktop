import { C } from "../design";

interface SourcePillProps {
  source: string; // "local" | "remote:hostname"
  status: "local" | "remote";
  nickname?: string; // resolved from device list; undefined = use hostname
}

export function SourcePill({ source, status, nickname }: SourcePillProps) {
  const label = nickname ?? (source.startsWith("remote:")
    ? source.replace("remote:", "")
    : source);

  // Dot color: local = accent, remote = muted text
  const dotColor = status === "local" ? C.accent : C.t2;

  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        background: C.card2,
        borderRadius: 6,
        padding: "2px 8px",
        maxWidth: 120,
        overflow: "hidden",
      }}
    >
      <span
        style={{
          width: 8,
          height: 8,
          borderRadius: "50%",
          backgroundColor: dotColor,
          flexShrink: 0,
        }}
      />
      <span
        style={{
          fontSize: 14,
          fontWeight: 500,
          lineHeight: "1.14",
          letterSpacing: "0.2px",
          color: C.t2,
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {label}
      </span>
    </span>
  );
}
