"use client";

import type { ReactNode } from "react";
import { cn } from "../utils";

export type ChipTone = "neutral" | "teal" | "success" | "warning" | "danger";

export function Chip({
  children,
  icon,
  tone = "neutral",
  onClick,
  title,
  className,
  ariaLabel,
}: {
  children: ReactNode;
  icon?: ReactNode;
  tone?: ChipTone;
  onClick?: () => void;
  title?: string;
  className?: string;
  ariaLabel?: string;
}) {
  const classes = cn("chip", `chip-${tone}`, className);
  const content = (
    <>
      {icon}
      <span className="chip-label">{children}</span>
    </>
  );
  if (!onClick) {
    return (
      <span className={classes} title={title}>
        {content}
      </span>
    );
  }
  return (
    <button
      type="button"
      className={classes}
      onClick={onClick}
      title={title}
      aria-label={ariaLabel}
    >
      {content}
    </button>
  );
}
