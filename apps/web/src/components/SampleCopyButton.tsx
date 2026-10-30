"use client";

import { ArrowRight, Copy } from "lucide-react";
import { useRouter } from "next/navigation";
import { useAccessKeyDialog } from "./AccessKeyDialogProvider";
import { Button } from "./Button";
import { useSession } from "../session/SessionProvider";

export function SampleCopyButton({ caseId }: { caseId: string }) {
  const { session } = useSession();
  const { openAccessKeyDialog } = useAccessKeyDialog();
  const router = useRouter();
  const destination = `/?source=${encodeURIComponent(caseId)}`;

  function continueToCopy() {
    if (session) {
      router.push(destination);
    } else {
      openAccessKeyDialog(() => router.push(destination));
    }
  }

  return (
    <Button onClick={continueToCopy}>
      <Copy size={15} aria-hidden="true" />
      Copy to a private case
      <ArrowRight size={14} aria-hidden="true" />
    </Button>
  );
}
