"use client";

import type { ReactNode } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";

export function InspectorPanel({
  open,
  onOpenChange,
  title,
  description,
  leading,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  leading?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content
          className="inspector-panel"
          aria-describedby={description ? "inspector-description" : undefined}
        >
          <div className="inspector-header">
            {leading}
            <div className="min-w-0 flex-1">
              <Dialog.Title className="inspector-title">{title}</Dialog.Title>
              {description && (
                <Dialog.Description
                  id="inspector-description"
                  className="inspector-subtitle"
                >
                  {description}
                </Dialog.Description>
              )}
            </div>
            <Dialog.Close asChild>
              <button
                type="button"
                className="icon-button"
                aria-label="Close panel"
              >
                <X size={18} aria-hidden="true" />
              </button>
            </Dialog.Close>
          </div>
          <div className="inspector-body">{children}</div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
