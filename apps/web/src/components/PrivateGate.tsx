"use client";

import { LockKeyhole } from "lucide-react";
import { Button } from "./Button";
import { useAccessKeyDialog } from "./AccessKeyDialogProvider";

export function PrivateGate() {
  const { openAccessKeyDialog } = useAccessKeyDialog();
  return (
    <section className="surface-card mt-8">
      <div className="empty-state">
        <div>
          <span className="empty-state-icon mx-auto">
            <LockKeyhole size={21} aria-hidden="true" />
          </span>
          <h2 className="mt-4 text-base font-semibold">
            Sign in to your private workspace
          </h2>
          <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-muted-foreground">
            Private cases are fetched only after you exchange an access key for
            a short-lived session. No private data is included in this page’s
            server render.
          </p>
          <div className="mt-5">
            <Button onClick={() => openAccessKeyDialog()}>
              Enter access key
            </Button>
          </div>
        </div>
      </div>
    </section>
  );
}
