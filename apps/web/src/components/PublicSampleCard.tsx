import Link from "next/link";
import { ArrowUpRight, BarChart3, FileSearch2, HandCoins } from "lucide-react";
import type { SyntheticWorkflowFixture } from "@evianta/core";
import { getSampleMetrics } from "../samples";
import { StatusBadge } from "./Badges";

const icons = {
  "data-analysis": BarChart3,
  "tax-notice": FileSearch2,
  "msme-payment": HandCoins,
};

const labels = {
  "data-analysis": "Data analysis",
  "tax-notice": "Tax notice",
  "msme-payment": "Delayed payment",
};

export function PublicSampleCard({
  fixture,
  featured = false,
}: {
  fixture: SyntheticWorkflowFixture;
  featured?: boolean;
}) {
  const Icon = icons[fixture.case.useCase];
  const metric = getSampleMetrics(fixture)[0];
  return (
    <Link
      href={`/samples/${fixture.case.id}`}
      className={`surface-card sample-card ${featured ? "ring-1 ring-primary/15" : ""}`}
    >
      <div className="flex items-start justify-between gap-3">
        <span
          className={`icon-tile ${featured ? "icon-tile-teal" : "icon-tile-blue"}`}
        >
          <Icon size={19} aria-hidden="true" />
        </span>
        <StatusBadge tone="info">Synthetic sample</StatusBadge>
      </div>
      <p className="mt-5 text-[10px] font-semibold uppercase tracking-[0.09em] text-muted-foreground">
        {labels[fixture.case.useCase]}
      </p>
      <h3 className="mt-2 text-base font-semibold tracking-tight">
        {fixture.case.title}
      </h3>
      <p className="mt-2 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
        {fixture.case.description}
      </p>
      <div className="sample-card-footer">
        <span>
          <span className="block text-[10px] text-muted-foreground">
            {metric.label}
          </span>
          <span className="mono-number mt-1 block text-sm font-medium">
            {metric.value}
          </span>
        </span>
        <span className="inline-flex items-center gap-1 text-xs font-medium text-primary">
          Open replay <ArrowUpRight size={14} aria-hidden="true" />
        </span>
      </div>
    </Link>
  );
}
