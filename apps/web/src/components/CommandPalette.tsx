"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import * as Dialog from "@radix-ui/react-dialog";
import { Command } from "cmdk";
import {
  ArrowRight,
  Command as CommandIcon,
  FilePlus2,
  Search,
} from "lucide-react";

const commands = [
  { label: "Open synthetic samples", href: "/", keywords: "sample replay" },
  { label: "View your cases", href: "/cases", keywords: "private workspace" },
  { label: "Create a new case", href: "/cases/new", keywords: "intake upload" },
  { label: "Admin usage", href: "/admin/usage", keywords: "cost tokens" },
];

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const router = useRouter();

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen((current) => !current);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  function navigate(href: string) {
    setOpen(false);
    router.push(href);
  }

  return (
    <>
      <button
        type="button"
        className="command-trigger"
        aria-label="Search workspace"
        onClick={() => setOpen(true)}
      >
        <Search size={16} aria-hidden="true" />
        <span>Search workspace</span>
        <kbd>
          <CommandIcon size={11} aria-hidden="true" /> K
        </kbd>
      </button>
      <Dialog.Root open={open} onOpenChange={setOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="dialog-overlay" />
          <Dialog.Content
            className="command-dialog"
            aria-label="Command palette"
          >
            <Dialog.Title className="sr-only">Search workspace</Dialog.Title>
            <Command label="Search workspace" className="command-root">
              <div className="command-input-wrap">
                <Search size={17} aria-hidden="true" />
                <Command.Input placeholder="Search pages and actions..." />
                <Dialog.Close asChild>
                  <button
                    className="icon-button command-close"
                    aria-label="Close command palette"
                  >
                    <span className="sr-only">Close</span>
                    <kbd>esc</kbd>
                  </button>
                </Dialog.Close>
              </div>
              <Command.List className="command-list">
                <Command.Empty className="command-empty">
                  No matching actions.
                </Command.Empty>
                <Command.Group heading="Navigate">
                  {commands.map((item, index) => (
                    <Command.Item
                      key={item.href}
                      value={`${item.label} ${item.keywords}`}
                      onSelect={() => navigate(item.href)}
                      className="command-item"
                    >
                      {index === 2 ? (
                        <FilePlus2 size={17} />
                      ) : (
                        <ArrowRight size={17} />
                      )}
                      <span>{item.label}</span>
                      <kbd>↵</kbd>
                    </Command.Item>
                  ))}
                </Command.Group>
              </Command.List>
              <p className="command-footer">
                Navigate with ↑ ↓ · Select with ↵ · Close with esc
              </p>
            </Command>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}
