import Link from "next/link";
import {
  ArrowRight,
  Check,
  CircleHelp,
  LockKeyhole,
  Sparkles,
} from "lucide-react";
import { publicSamples } from "../src/samples";
import { PublicSampleCard } from "../src/components/PublicSampleCard";
import { Reveal } from "../src/components/Reveal";
import { StatusBadge } from "../src/components/Badges";

const principles = [
  {
    title: "Source-linked",
    description:
      "Every material finding points back to the record that supports it.",
    icon: Check,
  },
  {
    title: "Uncertainty stays visible",
    description:
      "Missing documents become open questions, not made-up answers.",
    icon: CircleHelp,
  },
  {
    title: "Private by design",
    description:
      "Your session and private work never appear in public sample pages.",
    icon: LockKeyhole,
  },
];

export default function HomePage() {
  const featured = publicSamples.find(
    (fixture) => fixture.case.id === "sample-msme-overdue",
  );
  const samples = publicSamples.filter((fixture) => fixture !== featured);

  return (
    <div>
      <Reveal className="hero-panel">
        <div className="hero-grid">
          <div className="max-w-xl">
            <p className="page-eyebrow">
              <Sparkles size={14} aria-hidden="true" />
              Evidence Atlas · Synthetic preview
            </p>
            <h1 className="page-title mt-4">
              Make the evidence
              <br />
              easier to see.
            </h1>
            <p className="page-description">
              Evianta turns business records into clear, reviewable
              findings—keeping every conclusion connected to its source.
            </p>
            <div className="mt-6 flex flex-wrap items-center gap-3">
              <Link
                href={`/samples/${featured?.case.id ?? ""}`}
                className="button-link bg-primary text-primary-foreground shadow-soft hover:brightness-105"
              >
                Open the replay <ArrowRight size={15} aria-hidden="true" />
              </Link>
              <Link
                href="/cases/new"
                className="button-link button-link-secondary"
              >
                Try a workflow
              </Link>
            </div>
            <div className="mt-5 flex flex-wrap items-center gap-2">
              <StatusBadge tone="success">Deterministic fixtures</StatusBadge>
              <span className="text-[11px] text-muted-foreground">
                No model calls · No live records
              </span>
            </div>
          </div>
          <div
            className="hero-visual"
            role="img"
            aria-label="Illustration of source records connected to a finding"
          >
            <div className="hero-visual-header">
              <span>Evidence trail</span>
              <span className="mono-number">03 records</span>
            </div>
            <div className="hero-visual-row">
              <span className="hero-evidence">
                <span className="hero-evidence-dot" />
                Invoice ledger
              </span>
              <span className="text-[10px] text-muted-foreground">Matched</span>
            </div>
            <div className="hero-visual-row">
              <span className="hero-evidence">
                <span className="hero-evidence-dot coral" />
                Payment records
              </span>
              <span className="text-[10px] text-muted-foreground">
                Reconciled
              </span>
            </div>
            <div className="hero-visual-row">
              <span className="hero-evidence">
                <span className="hero-evidence-dot" />
                Delivery confirmation
              </span>
              <span className="badge badge-warning">Open question</span>
            </div>
            <div className="absolute bottom-3 right-4 font-mono text-[9px] text-muted-foreground">
              SYNTHETIC DATA · READ ONLY
            </div>
          </div>
        </div>
      </Reveal>

      <section aria-labelledby="sample-heading">
        <div className="section-heading">
          <div>
            <h2 id="sample-heading">Explore a synthetic replay</h2>
            <p>See how source records become reviewable findings.</p>
          </div>
          <Link
            href="/cases/new"
            className="inline-flex items-center gap-1 text-xs font-medium text-primary"
          >
            Start a private case <ArrowRight size={14} aria-hidden="true" />
          </Link>
        </div>
        <div className="card-grid">
          {featured && <PublicSampleCard fixture={featured} featured />}
          {samples.map((fixture) => (
            <PublicSampleCard fixture={fixture} key={fixture.case.id} />
          ))}
        </div>
      </section>

      <section aria-labelledby="principles-heading">
        <div className="section-heading">
          <div>
            <h2 id="principles-heading">Clarity you can check</h2>
            <p>
              A calm workspace, built around records and the people reviewing
              them.
            </p>
          </div>
        </div>
        <div className="grid gap-3 md:grid-cols-3">
          {principles.map(({ title, description, icon: Icon }) => (
            <div className="surface-card p-5" key={title}>
              <span className="icon-tile icon-tile-teal">
                <Icon size={18} aria-hidden="true" />
              </span>
              <h3 className="mt-4 text-sm font-semibold">{title}</h3>
              <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                {description}
              </p>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
