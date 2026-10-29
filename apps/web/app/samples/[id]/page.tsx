import { notFound } from "next/navigation";
import { findPublicSample } from "../../../src/samples";
import { SampleResult } from "../../../src/components/SampleResult";

export default async function SamplePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const fixture = findPublicSample(id);
  if (!fixture) notFound();
  return <SampleResult fixture={fixture} />;
}
