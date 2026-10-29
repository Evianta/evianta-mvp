import { CircleHelp, CircleCheck, CircleMinus, CircleX } from "lucide-react";
import type { ReactNode } from "react";

export type StatusTone = "neutral" | "success" | "warning" | "danger" | "info";

export function StatusBadge({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: StatusTone;
}) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

export function ConfidenceBadge({ confidence }: { confidence: number | null }) {
  if (confidence === null) {
    return (
      <StatusBadge>
        <CircleHelp size={13} aria-hidden="true" />
        Not assessed
      </StatusBadge>
    );
  }
  if (confidence >= 0.8) {
    return (
      <StatusBadge tone="success">
        <CircleCheck size={13} aria-hidden="true" />
        High confidence
      </StatusBadge>
    );
  }
  if (confidence >= 0.5) {
    return (
      <StatusBadge tone="warning">
        <CircleMinus size={13} aria-hidden="true" />
        Medium confidence
      </StatusBadge>
    );
  }
  return (
    <StatusBadge tone="danger">
      <CircleX size={13} aria-hidden="true" />
      Low confidence
    </StatusBadge>
  );
}
