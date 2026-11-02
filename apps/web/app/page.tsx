import { notFound } from "next/navigation";
import { findPublicSample, publicSamples } from "../src/samples";
import { PublicSampleCard } from "../src/components/PublicSampleCard";
import { ChatWorkspace } from "../src/components/ChatWorkspace";

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{ source?: string; case?: string }>;
}) {
  const { source, case: caseId } = await searchParams;
  const sourceSample = source ? findPublicSample(source) : undefined;
  if (source && !sourceSample) notFound();
  const featured = publicSamples.find(
    (fixture) => fixture.case.id === "sample-msme-overdue",
  );
  const samples = publicSamples.filter((fixture) => fixture !== featured);

  return (
    <ChatWorkspace sourceSample={sourceSample} caseId={caseId}>
      <section id="samples" aria-labelledby="sample-heading" className="mt-14">
        <div className="section-heading">
          <div>
            <h2 id="sample-heading">Or look at a finished case first</h2>
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
    </ChatWorkspace>
  );
}
