import type { ReactElement } from "react";
import { C } from "../design";
import { IconClipboard, IconSearch } from "../icons";

interface EmptyStateProps {
  variant: "no-clips" | "search-miss" | "no-remote";
  query?: string;
}

export function EmptyState({ variant, query }: EmptyStateProps) {
  const headingMap: Record<string, string> = {
    "no-clips": "Copy anything to start.",
    "search-miss": `No clips match \u201C${query}\u201D.`,
    "no-remote": "No remote clips yet.",
  };

  const bodyMap: Record<string, string> = {
    "no-clips": "Clips appear here instantly.",
    "search-miss": "Try a shorter word or clear the search.",
    "no-remote": "Push from another machine to see clips here.",
  };

  const iconMap: Record<string, ReactElement> = {
    "no-clips": <IconClipboard size={32} />,
    "search-miss": <IconSearch size={24} />,
    "no-remote": <IconClipboard size={32} />,
  };

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        flex: 1,
        padding: "32px 16px",
        textAlign: "center",
      }}
    >
      <div style={{ color: C.t3, marginBottom: 24 }}>
        {iconMap[variant]}
      </div>

      <div
        data-testid="empty-heading"
        style={{
          fontFamily: "Inter, system-ui, sans-serif",
          fontSize: 20,
          fontWeight: 500,
          color: C.t1,
          textWrap: "balance",
          lineHeight: 1.6,
          letterSpacing: "0.2px",
        }}
      >
        {headingMap[variant]}
      </div>

      <div
        data-testid="empty-body"
        style={{
          fontFamily: "Inter, system-ui, sans-serif",
          fontSize: 16,
          fontWeight: 500,
          color: C.t2,
          textWrap: "balance",
          lineHeight: 1.15,
          letterSpacing: "0.1px",
          marginTop: 8,
        }}
      >
        {bodyMap[variant]}
      </div>
    </div>
  );
}
