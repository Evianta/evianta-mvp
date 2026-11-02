"use client";

import { useState } from "react";
import { avatarFor } from "../agents";

const sizes = { sm: 28, md: 40, lg: 56, xl: 88 } as const;

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join("");
}

export function AgentAvatar({
  role,
  name,
  size = "md",
  src,
}: {
  role: string;
  name: string;
  size?: keyof typeof sizes;
  src?: string | null;
}) {
  const [failed, setFailed] = useState(false);
  const resolved = src === undefined ? avatarFor(role) : src;
  const pixels = sizes[size];
  if (!resolved || failed) {
    return (
      <span
        className="agent-avatar agent-avatar-fallback"
        style={{ width: pixels, height: pixels, fontSize: pixels * 0.36 }}
        aria-hidden="true"
      >
        {initials(name)}
      </span>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element -- tiny static SVG assets
    <img
      className="agent-avatar"
      src={resolved}
      alt=""
      width={pixels}
      height={pixels}
      onError={() => setFailed(true)}
    />
  );
}
