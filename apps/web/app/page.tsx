import Link from "next/link";
import { ArrowRight, Check, CircleHelp, LockKeyhole } from "lucide-react";
import { publicSamples } from "../src/samples";
import { PublicSampleCard } from "../src/components/PublicSampleCard";
import { CaseIntake } from "../src/components/CaseIntake";

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
      <CaseIntake />

      <section id="samples" aria-labelledby="sample-heading" className="mt-12">
        <div className="section-heading">
          <div>
            <h2 id="sample-heading">Explore a synthetic replay</h2>
            <p>Read-only synthetic previews. No model calls or live records.</p>
          </div>
          <Link
            href="/cases/new"
            className="inline-flex items-center gap-1 text-xs font-medium text-primary"
          >
            New task <ArrowRight size={14} aria-hidden="true" />
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
