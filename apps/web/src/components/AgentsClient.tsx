"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowRight, Wrench } from "lucide-react";
import type { AgentProfile } from "@evianta/core";
import {
  buildDirectory,
  categoryLabels,
  categoryOrder,
  workflowLabels,
  type AgentCategory,
  type DirectoryAgent,
} from "../agents";
import { useSession } from "../session/SessionProvider";
import { AgentAvatar } from "./AgentAvatar";
import { StatusBadge } from "./Badges";
import { InspectorPanel } from "./InspectorPanel";
import { LoadingSkeleton } from "./LoadingSkeleton";

const categoryTone = {
  lead: "info",
  specialist: "success",
  reviewer: "warning",
  system: "neutral",
} as const;

const categoryBadge: Record<AgentCategory, string> = {
  lead: "Lead",
  specialist: "Specialist",
  reviewer: "Reviewer",
  system: "System",
};

export function AgentsClient() {
  const { api } = useSession();
  const [profiles, setProfiles] = useState<AgentProfile[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<DirectoryAgent | null>(null);

  useEffect(() => {
    let active = true;
    void api
      .listAgentDirectory()
      .then((result) => {
        if (active) setProfiles(result);
      })
      .catch((reason: unknown) => {
        if (active)
          setError(
            reason instanceof Error
              ? reason.message
              : "The directory could not be loaded.",
          );
      });
    return () => {
      active = false;
    };
  }, [api]);

  const directory = useMemo(
    () => (profiles ? buildDirectory(profiles) : []),
    [profiles],
  );
  const lead = directory.find((agent) => agent.category === "lead");

  return (
    <div>
      <p className="page-eyebrow">AI professionals</p>
      <h1 className="page-title">Meet the team behind your case</h1>
      <p className="page-description">
        Evianta leads every task. She brings in specialists for the work, has a
        reviewer check it, and hands you a result you can verify.
      </p>

      {error && (
        <p className="surface-card mt-6 p-4 text-sm text-danger" role="alert">
          {error}
        </p>
      )}
      {!profiles && !error && (
        <div className="mt-7">
          <LoadingSkeleton rows={3} />
        </div>
      )}

      {lead && (
        <button
          type="button"
          className="surface-card agent-hero mt-7"
          onClick={() => setSelected(lead)}
        >
          <AgentAvatar role={lead.role} name={lead.displayName} size="xl" />
          <span className="min-w-0 flex-1 text-left">
            <span className="flex flex-wrap items-center gap-2">
              <span className="text-lg font-semibold">{lead.displayName}</span>
              <StatusBadge tone="info">Lead agent</StatusBadge>
            </span>
            <span className="mt-1 block text-sm text-muted-foreground">
              {lead.summary}
            </span>
            <span className="mt-3 flex flex-wrap gap-2">
              {lead.workflows.map((workflow) => (
                <StatusBadge key={workflow}>
                  {workflowLabels[workflow]}
                </StatusBadge>
              ))}
            </span>
          </span>
        </button>
      )}

      {categoryOrder
        .filter((category) => category !== "lead")
        .map((category) => {
          const agents = directory.filter((item) => item.category === category);
          if (!agents.length) return null;
          return (
            <section
              key={category}
              className="mt-9"
              aria-labelledby={`agents-${category}`}
            >
              <h2
                id={`agents-${category}`}
                className="text-sm font-semibold tracking-tight"
              >
                {categoryLabels[category]}
              </h2>
              <ul className="agent-grid mt-4">
                {agents.map((agent) => (
                  <li key={agent.role}>
                    <button
                      type="button"
                      className="surface-card agent-card"
                      onClick={() => setSelected(agent)}
                    >
                      <span className="flex items-start gap-3">
                        <AgentAvatar
                          role={agent.role}
                          name={agent.displayName}
                          size="lg"
                        />
                        <span className="min-w-0 text-left">
                          <span className="block text-sm font-semibold">
                            {agent.displayName}
                          </span>
                          <span className="mt-0.5 block text-xs text-muted-foreground">
                            {agent.tagline}
                          </span>
                        </span>
                      </span>
                      <span className="mt-3 block text-left text-xs leading-relaxed text-muted-foreground">
                        {agent.capabilities[0]}
                        {agent.capabilities.length > 1 &&
                          ` · +${agent.capabilities.length - 1} more`}
                      </span>
                      <span className="mt-3 flex flex-wrap gap-1.5">
                        <StatusBadge tone={categoryTone[agent.category]}>
                          {categoryBadge[agent.category]}
                        </StatusBadge>
                        {agent.workflows.length === 3 ? (
                          <StatusBadge>All workflows</StatusBadge>
                        ) : (
                          agent.workflows.map((workflow) => (
                            <StatusBadge key={workflow}>
                              {workflowLabels[workflow]}
                            </StatusBadge>
                          ))
                        )}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}

      <div className="surface-card mt-10 flex flex-wrap items-center justify-between gap-3 p-5">
        <div>
          <p className="text-sm font-semibold">Ready to put them to work?</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Describe the task to Evianta and attach your records.
          </p>
        </div>
        <Link
          href="/"
          className="button-link bg-primary text-primary-foreground shadow-soft"
        >
          Talk to Evianta <ArrowRight size={14} aria-hidden="true" />
        </Link>
      </div>

      <AgentInspector agent={selected} onClose={() => setSelected(null)} />
    </div>
  );
}

export function AgentInspector({
  agent,
  onClose,
}: {
  agent: DirectoryAgent | null;
  onClose: () => void;
}) {
  const [last, setLast] = useState<DirectoryAgent | null>(null);
  const shown = agent ?? last;
  useEffect(() => {
    if (agent) setLast(agent);
  }, [agent]);

  return (
    <InspectorPanel
      open={Boolean(agent)}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={shown?.displayName ?? "Agent"}
      description={shown?.tagline}
      leading={
        shown && (
          <AgentAvatar
            role={shown.role}
            name={shown.displayName}
            size="lg"
            src={shown.avatar}
          />
        )
      }
    >
      {shown && (
        <div className="space-y-5 text-sm">
          <div className="flex flex-wrap gap-2">
            <StatusBadge tone={categoryTone[shown.category]}>
              {categoryBadge[shown.category]}
            </StatusBadge>
            {shown.speed && <StatusBadge>{shown.speed}</StatusBadge>}
            {shown.workflows.map((workflow) => (
              <StatusBadge key={workflow}>
                {workflowLabels[workflow]}
              </StatusBadge>
            ))}
          </div>
          <p className="leading-relaxed text-muted-foreground">
            {shown.summary}
          </p>
          <PanelList title="What they can do" items={shown.capabilities} />
          <PanelList title="How they work" items={shown.procedures} />
          <PanelList title="What they hand back" items={shown.outputs} />
          <PanelList title="Good to know" items={shown.limitations} />
          {shown.tools.length > 0 && (
            <p className="flex items-center gap-2 text-xs text-muted-foreground">
              <Wrench size={14} aria-hidden="true" />
              Optional tools: {shown.tools.join(", ")}. Web research only runs
              when it is enabled for the task.
            </p>
          )}
        </div>
      )}
    </InspectorPanel>
  );
}

function PanelList({ title, items }: { title: string; items: string[] }) {
  if (!items.length) return null;
  return (
    <section>
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </h3>
      <ul className="mt-2 list-disc space-y-1.5 pl-5">
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </section>
  );
}
