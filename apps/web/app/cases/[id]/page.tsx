import { CaseWorkspaceClient } from "../../../src/components/CaseWorkspaceClient";

export default async function CasePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <CaseWorkspaceClient caseId={id} />;
}
