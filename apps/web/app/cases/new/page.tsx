import { notFound } from "next/navigation";
import { findPublicSample } from "../../../src/samples";
import { CaseIntake } from "../../../src/components/CaseIntake";

export default async function NewCasePage({
  searchParams,
}: {
  searchParams: Promise<{ source?: string }>;
}) {
  const { source } = await searchParams;
  const sourceSample = source ? findPublicSample(source) : undefined;
  if (source && !sourceSample) notFound();
  return <CaseIntake sourceSample={sourceSample} />;
}
