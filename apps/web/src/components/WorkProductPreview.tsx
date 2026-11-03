import {
  filingReadiness,
  savedWorkProduct,
  type Deliverable,
} from "@evianta/core";
import type { CaseWorkspace } from "../api/client";

export function WorkProductPreview({
  deliverable,
  workspace,
  onSelectDocument,
}: {
  deliverable: Deliverable;
  workspace: CaseWorkspace;
  onSelectDocument?: (id: string) => void;
}) {
  const product = savedWorkProduct(deliverable);
  if (!product) return null;
  const section = deliverable.sections[0];
  const readiness = filingReadiness(deliverable, {
    synthetic: workspace.case.synthetic,
    approval: workspace.approvals.find(
      (item) => item.deliverableId === deliverable.id,
    ),
  });
  return (
    <section
      aria-label={`Document preview: ${product.title}`}
      className="space-y-4"
    >
      <div className="rounded-lg border border-border bg-surface p-5">
        <h3 className="text-base font-semibold">{product.title}</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          {product.claimant} / {product.counterparty}
        </p>
        <p className="mt-4 whitespace-pre-wrap text-sm leading-relaxed">
          {product.body}
        </p>
        {product.schedules.map((schedule, index) => (
          <div key={index} className="mt-4 overflow-x-auto">
            <h4 className="text-sm font-medium">{schedule.title}</h4>
            <table className="mt-2 w-full text-left text-xs">
              <thead>
                <tr>
                  {schedule.columns.map((column, i) => (
                    <th key={i} className="border-b border-border p-2">
                      {column}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {schedule.rows.map((row, i) => (
                  <tr key={i}>
                    {row.map((value, j) => (
                      <td key={j} className="border-b border-border p-2">
                        {value ?? ""}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </div>
      <div className="text-xs text-muted-foreground">
        <p>
          Document review: {section?.reviewStatus ?? "pending"}. Filing
          requirements have not been validated.
        </p>
        <p className="mt-1">
          Downloads contain generated drafts and schedules only. Upload your
          originals separately.
        </p>
        {product.sources.length > 0 && (
          <div className="mt-3">
            <h4 className="font-medium">Referenced user-supplied evidence</h4>
            <ul className="list-inside list-disc">
              {product.sources.map((source, i) => (
                <li key={i}>
                  {onSelectDocument ? (
                    <button
                      type="button"
                      className="text-primary underline"
                      onClick={() => onSelectDocument(source.documentId)}
                    >
                      {source.reference}
                    </button>
                  ) : (
                    source.reference
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
        {product.missingOriginals.length > 0 && (
          <div className="mt-3">
            <h4 className="font-medium">Originals to provide separately</h4>
            <ul className="list-inside list-disc">
              {product.missingOriginals.map((item, i) => (
                <li key={i}>{item}</li>
              ))}
            </ul>
          </div>
        )}
        {product.reviewBlockers.length > 0 && (
          <div className="mt-3">
            <h4 className="font-medium">Professional verification required</h4>
            <ul className="list-inside list-disc">
              {product.reviewBlockers.map((item, i) => (
                <li key={i}>{item}</li>
              ))}
            </ul>
          </div>
        )}
        <div className="mt-3">
          <h4 className="font-medium">Draft filing checklist</h4>
          <ul className="list-inside list-disc">
            {readiness?.blockers.map((item, i) => (
              <li key={i}>{item}</li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}
