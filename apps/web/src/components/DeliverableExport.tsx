"use client";

import { useEffect, useRef, useState } from "react";
import { Download } from "lucide-react";
import type { Deliverable } from "@evianta/core";
import { useSession } from "../session/SessionProvider";
import {
  buildDeliverableExport,
  deliverableExportFormats,
  exportLabels,
  type ExportContext,
  type ExportFormat,
} from "../deliverable-export";

export function DeliverableExport({
  deliverable,
  context,
}: {
  deliverable: Deliverable;
  context?: ExportContext;
}) {
  const { api } = useSession();
  const menu = useRef<HTMLDetailsElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const formats = deliverableExportFormats(deliverable, context);
  const formatLabel = formats
    .map((format) => (format === "xlsx" ? "Excel" : format.toUpperCase()))
    .join(", ");

  async function download(format: ExportFormat) {
    setError(null);
    setPending(true);
    try {
      let blob: Blob;
      let filename: string;
      if (deliverable.workProduct) {
        if (!api.downloadDeliverable)
          throw new Error("Generated-file downloads are unavailable.");
        blob = await api.downloadDeliverable(deliverable, format);
        filename = `${
          deliverable.title
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-|-$/g, "") || "document"
        }-v${deliverable.version}.${format}`;
      } else {
        const file = await buildDeliverableExport(deliverable, format, context);
        blob = new Blob([file.content], { type: file.mimeType });
        filename = file.filename;
      }
      if (!active.current) return;
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      document.body.append(link);
      try {
        link.click();
      } finally {
        link.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
      if (menu.current) menu.current.open = false;
    } catch (reason: unknown) {
      if (active.current)
        setError(
          `Export failed: ${reason instanceof Error ? reason.message : "The file could not be created."}`,
        );
    } finally {
      if (active.current) setPending(false);
    }
  }

  if (!formats.length) return null;
  return (
    <div>
      <details ref={menu} className="relative">
        <summary
          className="chip chip-neutral cursor-pointer list-none"
          aria-label={`Export ${formatLabel} for ${deliverable.title}`}
        >
          <Download size={13} aria-hidden="true" /> Export{" "}
          <span className="text-muted-foreground">{formatLabel}</span>
        </summary>
        <div className="mt-1 w-56 max-w-full rounded-lg border border-border bg-surface p-2 shadow-soft sm:absolute sm:right-0 sm:z-10">
          {formats.map((format) => (
            <button
              key={format}
              type="button"
              className="block w-full rounded px-2 py-2 text-left text-xs hover:bg-background focus-visible:outline focus-visible:outline-primary"
              disabled={pending}
              onClick={() => void download(format)}
            >
              {exportLabels[format]}
            </button>
          ))}
          {pending && (
            <p role="status" className="px-2 py-1 text-xs">
              Preparing file...
            </p>
          )}
          <p className="px-2 pt-1 text-xs text-muted-foreground">
            For review, not validated for portal filing.
          </p>
        </div>
      </details>
      {error && (
        <p role="alert" className="mt-1 text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
