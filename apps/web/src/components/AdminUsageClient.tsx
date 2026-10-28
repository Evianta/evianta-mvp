"use client";

import { useEffect, useState } from "react";
import { ShieldAlert, WalletCards } from "lucide-react";
import type { AdminUsageResponse } from "../api/client";
import { ApiError } from "../api/errors";
import { formatDate } from "../format";
import { useSession } from "../session/SessionProvider";
import { EmptyState } from "./EmptyState";
import { LoadingSkeleton } from "./LoadingSkeleton";
import { PrivateGate } from "./PrivateGate";
import { StatusBadge } from "./Badges";

const usd = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 4,
});

export function AdminUsageClient() {
  const { session, api } = useSession();
  const [usage, setUsage] = useState<AdminUsageResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    let active = true;
    setUsage(null);
    setError(null);
    if (!session)
      return () => {
        active = false;
      };
    setLoading(true);
    void api
      .getAdminUsage()
      .then((result) => {
        if (active) setUsage(result);
      })
      .catch((reason: unknown) => {
        if (active) setError(reason);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [api, session]);

  if (!session) return <PrivateGate />;
  if (loading) return <LoadingSkeleton rows={4} />;
  if (error instanceof ApiError && error.status === 403) {
    return (
      <div className="reading-column">
        <p className="page-eyebrow">Administration</p>
        <h1 className="page-title">Usage overview</h1>
        <div className="surface-card mt-6">
          <EmptyState
            icon={ShieldAlert}
            title="Administrator access required"
            description="The server denied this request. Usage access is authorized by the API, not by this page."
          />
        </div>
      </div>
    );
  }
  if (error) {
    return (
      <div className="surface-card p-5" role="alert">
        <p className="text-sm font-semibold text-danger">
          Usage data could not be loaded.
        </p>
        <p className="mt-2 text-xs text-muted-foreground">
          {error instanceof Error
            ? error.message
            : "The server returned an unknown error."}
        </p>
      </div>
    );
  }
  if (!usage) return null;

  return (
    <div>
      <div>
        <p className="page-eyebrow">Administration</p>
        <h1 className="page-title">Usage overview</h1>
        <p className="page-description">
          Cost and exposure metadata only. This view never includes private
          document links.
        </p>
      </div>
      <div className="metric-grid mt-7">
        <div className="surface-card metric-card">
          <p className="metric-label">Known estimated cost</p>
          <p className="metric-value">
            {usd.format(usage.totals.knownCostUsd)}
          </p>
          <p className="metric-caption">
            Provider estimates, not final invoices
          </p>
        </div>
        <div className="surface-card metric-card">
          <p className="metric-label">Unknown cost records</p>
          <p className="metric-value">{usage.totals.unknownCostCount}</p>
          <p className="metric-caption">
            Exposure is shown without a fabricated amount
          </p>
        </div>
        <div className="surface-card metric-card">
          <p className="metric-label">Recorded attempts</p>
          <p className="metric-value">{usage.rows.length}</p>
          <p className="metric-caption">Usage metadata only</p>
        </div>
      </div>
      <section
        className="surface-card mt-6 overflow-hidden"
        aria-labelledby="usage-table-heading"
      >
        <div className="border-b border-border px-5 py-4">
          <h2 id="usage-table-heading" className="text-sm font-semibold">
            Provider usage records
          </h2>
          <p className="mt-1 text-[11px] text-muted-foreground">
            User, case and run identifiers are included for audit context.
          </p>
        </div>
        {usage.rows.length === 0 ? (
          <EmptyState
            icon={WalletCards}
            title="No usage records"
            description="Usage appears here when the server has recorded a provider attempt."
          />
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">Provider / model</th>
                  <th scope="col">User</th>
                  <th scope="col">Case / run</th>
                  <th scope="col">Cost status</th>
                  <th scope="col">Recorded</th>
                </tr>
              </thead>
              <tbody>
                {usage.rows.map((row) => (
                  <tr key={row.id}>
                    <td>
                      <p className="font-medium">{row.provider}</p>
                      <p className="mt-1 text-[10px] text-muted-foreground">
                        {row.model}
                      </p>
                    </td>
                    <td className="mono-number text-[11px]">{row.ownerId}</td>
                    <td>
                      <p className="mono-number text-[10px]">{row.caseId}</p>
                      <p className="mono-number mt-1 text-[10px] text-muted-foreground">
                        {row.runId}
                      </p>
                    </td>
                    <td>
                      {row.costStatus === "unknown" ? (
                        <StatusBadge tone="warning">
                          Unknown exposure
                        </StatusBadge>
                      ) : (
                        <span className="mono-number text-xs">
                          {row.costUsd === null ? "—" : usd.format(row.costUsd)}
                        </span>
                      )}
                    </td>
                    <td className="text-muted-foreground">
                      {formatDate(row.recordedAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
