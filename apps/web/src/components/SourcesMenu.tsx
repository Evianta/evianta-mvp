"use client";

import { useEffect, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { ArrowLeft, Database, FileUp, Plug, Settings2, X } from "lucide-react";
import { Button } from "./Button";

interface Source {
  id: string;
  name: string;
  blurb: string;
  group: string;
  tint: string;
}

const sources: Source[] = [
  {
    id: "tally",
    name: "Tally",
    blurb: "Ledgers, receipts, outstanding receivables, and sales registers",
    group: "Accounting",
    tint: "teal",
  },
  {
    id: "busy",
    name: "Busy",
    blurb: "Ledgers and sales registers",
    group: "Accounting",
    tint: "blue",
  },
  {
    id: "zoho-books",
    name: "Zoho Books",
    blurb: "Invoices, customer statements, items, and budgets",
    group: "Accounting",
    tint: "amber",
  },
  {
    id: "shopify",
    name: "Shopify",
    blurb: "Orders and products",
    group: "Commerce",
    tint: "green",
  },
  {
    id: "gmail",
    name: "Gmail",
    blurb: "Email threads such as payment reminders and tax intimations",
    group: "Email",
    tint: "coral",
  },
  {
    id: "outlook",
    name: "Outlook",
    blurb: "Email threads such as purchase orders and buyer correspondence",
    group: "Email",
    tint: "blue",
  },
  {
    id: "google-drive",
    name: "Google Drive",
    blurb: "Files and Sheets such as Form 26AS, certificates, and targets",
    group: "Files",
    tint: "violet",
  },
];

const groups = ["Accounting", "Commerce", "Email", "Files"];

export function SourcesMenu({
  disabled,
  onUploadInstead,
}: {
  disabled?: boolean;
  onUploadInstead: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [selected, setSelected] = useState<Source | null>(null);
  const wrapper = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const close = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent) {
        if (event.key === "Escape") setMenuOpen(false);
        return;
      }
      if (!wrapper.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [menuOpen]);

  function openDialog() {
    setMenuOpen(false);
    setSelected(null);
    setDialogOpen(true);
  }

  return (
    <div className="relative" ref={wrapper}>
      <button
        type="button"
        className="composer-pill"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        disabled={disabled}
        onClick={() => setMenuOpen((open) => !open)}
      >
        <Database size={15} aria-hidden="true" /> Sources
      </button>
      {menuOpen && (
        <div className="source-menu" role="menu" aria-label="Data sources">
          <p className="source-menu-title">Use data from</p>
          <p className="source-menu-copy">
            No data sources yet. Connect one and Evianta will suggest matching
            items for this case.
          </p>
          <button
            type="button"
            role="menuitem"
            className="source-menu-item"
            onClick={openDialog}
          >
            <Plug size={16} aria-hidden="true" /> Connect a source
          </button>
          <button
            type="button"
            role="menuitem"
            className="source-menu-item"
            onClick={openDialog}
          >
            <Settings2 size={16} aria-hidden="true" /> Manage data sources
          </button>
        </div>
      )}
      <Dialog.Root open={dialogOpen} onOpenChange={setDialogOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="dialog-overlay" />
          <Dialog.Content
            className="dialog-content sources-dialog"
            aria-describedby="sources-description"
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <Dialog.Title className="text-lg font-semibold">
                  {selected ? selected.name : "Connect a source"}
                </Dialog.Title>
                <Dialog.Description
                  id="sources-description"
                  className="mt-1 text-sm text-muted-foreground"
                >
                  {selected
                    ? "A preview of how this source would look. All connections are demos with synthetic data."
                    : "Link the apps your records live in. When a case needs something, Evianta suggests matching items and you choose what to attach. All connections here are demos with synthetic data."}
                </Dialog.Description>
              </div>
              <Dialog.Close asChild>
                <button
                  type="button"
                  className="icon-button -mr-2 -mt-2"
                  aria-label="Close"
                >
                  <X size={18} aria-hidden="true" />
                </button>
              </Dialog.Close>
            </div>

            {selected ? (
              <div className="mt-5">
                {/* eslint-disable-next-line @next/next/no-img-element -- static illustration */}
                <img
                  src={`/connectors/${selected.id}.svg`}
                  alt={`Illustration of ${selected.name} showing synthetic sample data`}
                  className="source-shot"
                />
                <p className="mt-4 text-sm text-muted-foreground">
                  Connecting is not available yet. For now, upload the files you
                  need and Evianta will use those.
                </p>
                <div className="mt-5 flex flex-wrap justify-between gap-2">
                  <Button variant="secondary" onClick={() => setSelected(null)}>
                    <ArrowLeft size={15} aria-hidden="true" /> All sources
                  </Button>
                  <Button
                    onClick={() => {
                      setDialogOpen(false);
                      onUploadInstead();
                    }}
                  >
                    <FileUp size={15} aria-hidden="true" /> Upload files instead
                  </Button>
                </div>
              </div>
            ) : (
              <div className="mt-5 space-y-5">
                {groups.map((group) => (
                  <section key={group} aria-labelledby={`source-${group}`}>
                    <h3
                      id={`source-${group}`}
                      className="text-xs font-semibold uppercase tracking-wide text-muted-foreground"
                    >
                      {group}
                    </h3>
                    <ul className="source-grid mt-2">
                      {sources
                        .filter((source) => source.group === group)
                        .map((source) => (
                          <li key={source.id}>
                            <button
                              type="button"
                              className="source-tile"
                              onClick={() => setSelected(source)}
                            >
                              <span
                                className={`source-mark source-mark-${source.tint}`}
                                aria-hidden="true"
                              >
                                {source.name[0]}
                              </span>
                              <span className="min-w-0 text-left">
                                <span className="flex items-center gap-2 text-sm font-medium">
                                  {source.name}
                                  <span className="badge badge-neutral">
                                    Demo
                                  </span>
                                </span>
                                <span className="mt-1 block text-xs text-muted-foreground">
                                  {source.blurb}
                                </span>
                              </span>
                            </button>
                          </li>
                        ))}
                    </ul>
                  </section>
                ))}
              </div>
            )}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}
