import { C } from "../design";

interface OfflineBarProps {
  visible: boolean;
}

export function OfflineBar({ visible }: OfflineBarProps) {
  if (!visible) return null;

  return (
    <div
      style={{
        width: "100%",
        height: 36,
        background: C.card,
        borderBottom: `1px solid ${C.border}`,
        display: "flex",
        alignItems: "center",
        padding: "0 16px",
        gap: 8,
        opacity: visible ? 1 : 0,
        transition: "opacity 200ms ease-out",
        flexShrink: 0,
      }}
    >
      <span
        className="offline-pulse-dot"
        style={{
          width: 8,
          height: 8,
          borderRadius: "50%",
          backgroundColor: C.warning,
          animation: "pulse 2s ease-in-out infinite",
          flexShrink: 0,
        }}
      />
      <span
        style={{
          fontSize: 14,
          fontWeight: 500,
          color: C.t2,
        }}
      >
        Offline — clips will sync when reconnected
      </span>
    </div>
  );
}
