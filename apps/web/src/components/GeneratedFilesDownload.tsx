"use client";

import { useRef, useEffect, useState } from "react";
import type { Deliverable } from "@evianta/core";
import {
  buildGeneratedBundle,
  deliverableExportFormats,
  type ExportContext,
} from "../deliverable-export";
import { useSession } from "../session/SessionProvider";

export function GeneratedFilesDownload({
  deliverables,
  context,
}: {
  deliverables: Deliverable[];
  context: ExportContext;
}) {
  const { api } = useSession();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const products = deliverables.filter((item) => item.workProduct);
  if (!products.length) return null;

  async function download() {
    setPending(true);
    setError(null);
    try {
      const downloader = api.downloadDeliverable?.bind(api);
      if (!downloader)
        throw new Error("Generated-file downloads are unavailable.");
      const files = await Promise.all(
        products.flatMap((item) =>
          deliverableExportFormats(item, context).map(async (format) => ({
            filename: `${item.title.replace(/[^a-zA-Z0-9._-]/g, "-")}-v${item.version}.${format}`,
            content: new Uint8Array(
              await (await downloader(item, format)).arrayBuffer(),
            ),
          })),
        ),
      );
      if (!active.current) return;
      const content = await buildGeneratedBundle(files);
      if (!active.current) return;
      const url = URL.createObjectURL(
        new Blob([content], { type: "application/zip" }),
      );
      const link = document.createElement("a");
      link.href = url;
      link.download = "generated-drafts-and-schedules.zip";
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (reason) {
      if (active.current)
        setError(
          `Download failed: ${reason instanceof Error ? reason.message : "The bundle could not be prepared."}`,
        );
    } finally {
      if (active.current) setPending(false);
    }
  }
  return (
    <div>
      <button
        type="button"
        className="chip chip-neutral"
        disabled={pending}
        onClick={() => void download()}
      >
        {pending
          ? "Preparing generated files..."
          : "Download all generated files"}
      </button>
      <p className="mt-1 text-xs text-muted-foreground">
        Original evidence is not included.
      </p>
      {error && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
