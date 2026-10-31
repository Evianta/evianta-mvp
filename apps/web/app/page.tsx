import { notFound } from "next/navigation";
import { Check, CircleHelp, ListChecks } from "lucide-react";
import { findPublicSample, publicSamples } from "../src/samples";
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
    title: "Ready for review",
    description:
      "Keep progress, charts and supporting records together in one case.",
    icon: ListChecks,
  },
];

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{ source?: string }>;
}) {
  const { source } = await searchParams;
  const sourceSample = source ? findPublicSample(source) : undefined;
  if (source && !sourceSample) notFound();
  const featured = publicSamples.find(
    (fixture) => fixture.case.id === "sample-msme-overdue",
  );
  const samples = publicSamples.filter((fixture) => fixture !== featured);

  return (
    <div>
      <CaseIntake sourceSample={sourceSample} />

      <section id="samples" aria-labelledby="sample-heading" className="mt-12">
        <div className="section-heading">
          <div>
            <h2 id="sample-heading">Explore a synthetic replay</h2>
            <p>Read-only synthetic previews. No model calls or live records.</p>
          </div>
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
