"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useReducedMotion } from "framer-motion";

const TICK_MS = 28;
const MAX_REVEAL_MS = 1600;

/** Reveals text word by word. Capped in duration, instant under reduced motion. */
export function useStreamedText(text: string, animate: boolean) {
  const reduced = useReducedMotion();
  const tokens = useMemo(() => text.match(/\s+|\S+/g) ?? [], [text]);
  const instant = !animate || Boolean(reduced);
  const [count, setCount] = useState(instant ? tokens.length : 0);

  useEffect(() => {
    if (instant) {
      setCount(tokens.length);
      return;
    }
    setCount(0);
    const step = Math.max(
      1,
      Math.ceil(tokens.length / (MAX_REVEAL_MS / TICK_MS)),
    );
    const timer = window.setInterval(() => {
      setCount((current) => {
        const next = Math.min(tokens.length, current + step);
        if (next >= tokens.length) window.clearInterval(timer);
        return next;
      });
    }, TICK_MS);
    return () => window.clearInterval(timer);
  }, [instant, tokens]);

  const complete = useCallback(() => setCount(tokens.length), [tokens.length]);
  return {
    visible: tokens.slice(0, count).join(""),
    done: count >= tokens.length,
    complete,
  };
}

export function StreamedText({
  text,
  animate,
  className,
}: {
  text: string;
  animate: boolean;
  className?: string;
}) {
  const { visible, done, complete } = useStreamedText(text, animate);
  if (done) return <p className={className}>{text}</p>;
  return (
    <p className={className} onClick={complete} data-streaming="true">
      <span className="sr-only">{text}</span>
      <span aria-hidden="true">{visible}</span>
      <span className="stream-caret" aria-hidden="true" />
    </p>
  );
}
