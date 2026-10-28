"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useAutoAnimate } from "@formkit/auto-animate/react";
import { ArrowRight, FilePlus2, FolderOpen } from "lucide-react";
import type { Case } from "@evianta/core";
import { ApiError } from "../api/errors";
import { formatDate } from "../format";
import { useSession } from "../session/SessionProvider";
import { Button } from "./Button";
import { EmptyState } from "./EmptyState";
import { LoadingSkeleton } from "./LoadingSkeleton";
import { PrivateGate } from "./PrivateGate";
import { StatusBadge } from "./Badges";

const workflowNames: Record<Case["useCase"], string> = {
  "data-analysis": "Data analysis",
  "tax-notice": "Tax notice",
  "msme-payment": "Delayed payment",
};

export function CasesClient() {
  const [listRef] = useAutoAnimate<HTMLTableSectionElement>();
  const { session, api } = useSession();
  const [cases, setCases] = useState<Case[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [retryCount, setRetryCount] = useState(0);

  useEffect(() => {
    let active = true;
    setCases([]);
    setError(null);
    if (!session)
      return () => {
        active = false;
      };

    setLoading(true);
    void api
      .listCases()
      .then((result) => {
        if (active) setCases(result);
      })
      .catch((reason: unknown) => {
        if (active) {
          setError(
            reason instanceof Error
              ? reason.message
              : "Cases could not be loaded.",
          );
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [api, retryCount, session]);

  if (!session) return <PrivateGate />;

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="page-eyebrow">Private workspace</p>
          <h1 className="page-title">Your cases</h1>
          <p className="page-description">
            Review evidence and analysis for work you own. Private data is never
            shared with sample pages.
          </p>
        </div>
        <Link
          href="/cases/new"
          className="button-link bg-primary text-primary-foreground shadow-soft hover:brightness-105"
        >
          <FilePlus2 size={15} aria-hidden="true" />
          New case
        </Link>
      </div>

      <section
        className="surface-card mt-7 overflow-hidden"
        aria-labelledby="case-list-heading"
      >
        <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-4">
          <div>
            <h2 id="case-list-heading" className="text-sm font-semibold">
              Case register
            </h2>
            <p className="mt-1 text-[11px] text-muted-foreground">
              {cases.length} {cases.length === 1 ? "case" : "cases"} · Updated
              time shown in IST
            </p>
          </div>
          <FolderOpen
            size={18}
            className="text-muted-foreground"
            aria-hidden="true"
          />
        </div>
        {loading ? (
          <div className="p-5">
            <LoadingSkeleton rows={3} />
          </div>
        ) : error ? (
          <div className="p-5" role="alert">
            <p className="text-sm font-medium text-danger">
              The case register could not be loaded.
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {error instanceof Error
                ? error.message
                : "Cases could not be loaded."}
            </p>
            <Button
              className="mt-4"
              size="sm"
              variant="secondary"
              onClick={() => setRetryCount((count) => count + 1)}
            >
              Try again
            </Button>
          </div>
        ) : cases.length === 0 ? (
          <EmptyState
            icon={FolderOpen}
            title="No cases yet"
            description="Create a private case to organize documents and review findings."
            action={
              <Link
                href="/cases/new"
                className="button-link bg-primary text-primary-foreground"
              >
                Create a case <ArrowRight size={14} aria-hidden="true" />
              </Link>
            }
          />
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">Case</th>
                  <th scope="col">Workflow</th>
                  <th scope="col">Updated</th>
                  <th scope="col">Status</th>
                  <th scope="col">
                    <span className="sr-only">Open case</span>
                  </th>
                </tr>
              </thead>
              <tbody ref={listRef}>
                {cases.map((record) => (
                  <tr key={record.id}>
                    <td>
                      <Link
                        className="font-medium hover:text-primary"
                        href={`/cases/${record.id}`}
                      >
                        {record.title}
                      </Link>
                      <p className="mt-1 max-w-md truncate text-[11px] text-muted-foreground">
                        {record.description || "No description"}
                      </p>
                    </td>
                    <td>{workflowNames[record.useCase]}</td>
                    <td className="text-muted-foreground">
                      {formatDate(record.updatedAt)}
                    </td>
                    <td>
                      <StatusBadge
                        tone={
                          record.status === "active" ? "success" : "neutral"
                        }
                      >
                        {record.status}
                      </StatusBadge>
                    </td>
                    <td className="text-right">
                      <Link
                        href={`/cases/${record.id}`}
                        className="icon-button ml-auto"
                        aria-label={`Open ${record.title}`}
                      >
                        <ArrowRight size={16} aria-hidden="true" />
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <p className="mt-4 text-[11px] text-muted-foreground">
        {error instanceof ApiError && error.status === 401
          ? "Your session expired. Enter your key again to continue."
          : "Private responses use no-store caching and remain scoped to this session."}
      </p>
    </div>
  );
}
