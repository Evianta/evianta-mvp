import { publicSamples } from "../../src/samples";
import { PublicSampleCard } from "../../src/components/PublicSampleCard";

export const metadata = { title: "Samples | Evianta" };

export default function SamplesPage() {
  const featured = publicSamples.find(
    (fixture) => fixture.case.id === "sample-msme-overdue",
  );
  const others = publicSamples.filter((fixture) => fixture !== featured);
  return (
    <div>
      <p className="page-eyebrow">Synthetic replay</p>
      <h1 className="page-title">Explore a finished case</h1>
      <p className="page-description">
        Read-only synthetic previews with no model calls and no live records.
        Open one to see findings, evidence and the response pack.
      </p>
      <div className="card-grid mt-7">
        {featured && <PublicSampleCard fixture={featured} featured />}
        {others.map((fixture) => (
          <PublicSampleCard fixture={fixture} key={fixture.case.id} />
        ))}
      </div>
    </div>
  );
}
