"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";
import { useReducedMotion } from "framer-motion";
import {
  ArrowDown,
  ChartNoAxesCombined,
  FileText,
  Landmark,
} from "lucide-react";
import type {
  AgentProfile,
  IntakeConfiguration,
  RunDto,
  SyntheticWorkflowFixture,
  UseCase,
} from "@evianta/core";
import type { CaseWorkspace } from "../api/client";
import { agentNameForRole } from "../agents";
import {
  buildTaskDescription,
  planNextStep,
  resolveWorkflow,
  workflowLabels,
  workflowSlots,
  type AttachedFile,
  type Draft,
  type FactSpec,
  type SlotAssignment,
} from "../chat/analysis";
import {
  errorText,
  guardApi,
  isRejected,
  isStale,
  makeId,
  sleep,
} from "../chat/flow-utils";
import {
  applyRunEvent,
  createProgress,
  isTerminalStatus,
  type ProgressState,
} from "../chat/narration";
import {
  buildResult,
  pendingInputQuestions,
  type PendingQuestion,
  type ResultSummary,
} from "../chat/results";
import {
  chatReducer,
  type ChatMessage,
  type InspectTarget,
  type NoticeAction,
  type SetupStep,
  type StepStatus,
} from "../chat/types";
import {
  intakeCaseDetails,
  starterPrompts,
  validateUploadFile,
  workflowSpecs,
} from "../intake";
import { useSession } from "../session/SessionProvider";
import { useAccessKeyDialog } from "./AccessKeyDialogProvider";
import { AgentAvatar } from "./AgentAvatar";
import { ChatInspector } from "./ChatInspector";
import { Chip } from "./Chip";
import { Composer } from "./Composer";
import { ConfirmDialog } from "./ConfirmDialog";
import { MessageView, type MessageContext } from "./MessageViews";

type Awaiting =
  | { type: "prompt" }
  | { type: "workflow"; messageId: string }
  | { type: "slot"; slotId: string; messageId: string }
  | { type: "fact"; fact: FactSpec; messageId: string }
  | { type: "run-question" };

interface SetupState {
  caseId: string | null;
  uploaded: Set<string>;
}

interface RunQuestions {
  caseId: string;
  runId: string;
  messageId: string;
  questions: PendingQuestion[];
  uploaded: Set<File>;
  answers: Record<string, { question: string; answer: string }>;
  key: string | null;
}

const examplePrompt =
  "For example: reply to my 143(1) intimation about a TDS mismatch";

const suggestionIcons: Record<UseCase, typeof FileText> = {
  "data-analysis": ChartNoAxesCombined,
  "tax-notice": FileText,
  "msme-payment": Landmark,
};

const acceptedExtensions = [
  ...new Set(
    Object.values(workflowSpecs).flatMap((spec) => spec.allowedExtensions),
  ),
];
const acceptedMimeTypes = [
  ...new Set(
    Object.values(workflowSpecs).flatMap((spec) => spec.allowedMimeTypes),
  ),
];
const acceptAttribute = [...acceptedExtensions, ...acceptedMimeTypes].join(",");

async function readAttachment(file: File): Promise<AttachedFile> {
  const lower = file.name.toLowerCase();
  let header: string | undefined;
  let sample: string | undefined;
  if (/\.(csv|tsv|tab|txt|text|md|markdown|json)$/.test(lower)) {
    const head = await file.slice(0, 8192).text();
    sample = head.slice(0, 4000);
    if (/\.(csv|tsv|tab)$/.test(lower)) {
      header = head.split(/\r?\n/, 1)[0]?.replaceAll(/[_-]/g, " ");
    }
  }
  return { id: makeId("file"), file, header, sample };
}

function limitsFor(config: IntakeConfiguration | null) {
  return {
    ...workflowSpecs["data-analysis"],
    allowedExtensions: acceptedExtensions,
    allowedMimeTypes: acceptedMimeTypes,
    maxFileBytes: Math.min(
      workflowSpecs["data-analysis"].maxFileBytes,
      config?.uploadMaxBytes ?? workflowSpecs["data-analysis"].maxFileBytes,
    ),
  };
}

function ChatSession({
  sourceSample,
  caseId: initialCaseId,
  children,
}: {
  sourceSample?: SyntheticWorkflowFixture;
  caseId?: string;
  children?: ReactNode;
}) {
  const router = useRouter();
  const reducedMotion = useReducedMotion();
  const { session, api } = useSession();
  const { openAccessKeyDialog } = useAccessKeyDialog();
  const aliveRef = useRef(true);
  const guardedApi = useMemo(
    () => guardApi(api, () => aliveRef.current),
    [api],
  );

  const [messages, dispatch] = useReducer(chatReducer, []);
  const [text, setText] = useState(sourceSample?.case.description ?? "");
  const [composerFiles, setComposerFiles] = useState<
    (AttachedFile & { status: "reading" | "ready" })[]
  >([]);
  const [composerError, setComposerError] = useState<string | null>(null);
  const [busy, setBusyState] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [awaitingKind, setAwaitingKind] = useState<string | null>(null);
  const [awaitingHint, setAwaitingHint] = useState<string | null>(null);
  const [progressMap, setProgressMap] = useState<Record<string, ProgressState>>(
    {},
  );
  const [resultMap, setResultMap] = useState<Record<string, ResultSummary>>({});
  const [workspaces, setWorkspaces] = useState<Record<string, CaseWorkspace>>(
    {},
  );
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [profiles, setProfiles] = useState<AgentProfile[]>([]);
  const [inspect, setInspect] = useState<{
    target: InspectTarget;
    caseId: string | null;
  } | null>(null);
  const [stopOpen, setStopOpen] = useState(false);
  const [away, setAway] = useState(false);

  const apiRef = useRef(api);
  const sessionRef = useRef(session);
  const profilesRef = useRef<AgentProfile[]>([]);
  const configRef = useRef<IntakeConfiguration | null>(null);
  const draftRef = useRef<Draft | null>(null);
  const awaitingRef = useRef<Awaiting | null>(null);
  const busyRef = useRef(false);
  const blockedRef = useRef(false);
  const announcedRef = useRef(false);
  const signInCardRef = useRef(false);
  const pendingSignInRef = useRef(false);
  const setupRef = useRef<SetupState>({ caseId: null, uploaded: new Set() });
  const sampleRef = useRef(sourceSample ?? null);
  const progressRef = useRef<Record<string, ProgressState>>({});
  const runQuestionsRef = useRef<RunQuestions | null>(null);
  const retryRef = useRef<(() => void) | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const refreshTimer = useRef<number | null>(null);
  const hydratedRef = useRef<string | null>(null);
  const advanceRef = useRef<() => Promise<void>>(async () => undefined);
  const attachRequestRef = useRef(false);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const filePickerRef = useRef<HTMLInputElement | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);
  const stickRef = useRef(true);
  const activeRunRef = useRef<{ caseId: string; runId: string } | null>(null);

  apiRef.current = guardedApi;
  sessionRef.current = session;
  profilesRef.current = profiles;

  const setBusy = (value: boolean) => {
    busyRef.current = value;
    setBusyState(value);
  };
  const setAwaiting = (value: Awaiting | null) => {
    awaitingRef.current = value;
    setAwaitingKind(value?.type ?? null);
    setAwaitingHint(value?.type === "fact" ? value.fact.freeTextHint : null);
  };
  const block = () => {
    blockedRef.current = true;
    setBlocked(true);
  };

  const say = (message: string, animate = true) =>
    dispatch({
      type: "add",
      message: {
        id: makeId("m"),
        from: "evianta",
        type: "text",
        text: message,
        animate,
      },
    });
  const notice = (
    tone: "info" | "warning" | "danger",
    message: string,
    action?: NoticeAction,
  ) =>
    dispatch({
      type: "add",
      message: {
        id: makeId("m"),
        from: "evianta",
        type: "notice",
        tone,
        text: message,
        action,
      },
    });
  const nameOf = (role: string) => agentNameForRole(role, profilesRef.current);

  const updateProgress = (
    runId: string,
    change: (state: ProgressState) => ProgressState,
  ) => {
    const current = progressRef.current[runId];
    if (!current) return;
    const next = change(current);
    progressRef.current = { ...progressRef.current, [runId]: next };
    setProgressMap(progressRef.current);
  };

  // Static data: the public team directory and, once signed in, upload limits.
  useEffect(() => {
    let active = true;
    void api
      .listAgentDirectory()
      .then((result) => {
        if (active) setProfiles(result);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [api]);

  useEffect(() => {
    if (!session) {
      configRef.current = null;
      return;
    }
    let active = true;
    void api
      .getIntakeConfiguration()
      .then((result) => {
        if (active) configRef.current = result;
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [api, session]);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      abortRef.current?.abort();
      if (refreshTimer.current) window.clearTimeout(refreshTimer.current);
    };
  }, []);

  // Keep the newest message in view unless the reader scrolled away.
  useEffect(() => {
    const onScroll = () => {
      const nearBottom =
        window.innerHeight + window.scrollY >=
        document.documentElement.scrollHeight - 220;
      stickRef.current = nearBottom;
      setAway(!nearBottom);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    if (!messages.length) return;
    const last = messages.at(-1);
    if (stickRef.current || last?.from === "user") {
      endRef.current?.scrollIntoView({
        block: "end",
        behavior: reducedMotion ? "auto" : "smooth",
      });
    }
  }, [messages, progressMap, resultMap, reducedMotion]);

  // ---------------------------------------------------------------- flow

  const askSignIn = () => {
    pendingSignInRef.current = true;
    if (signInCardRef.current) return;
    signInCardRef.current = true;
    dispatch({
      type: "add",
      message: { id: makeId("m"), from: "evianta", type: "sign-in" },
    });
  };

  const advance = async () => {
    const draft = draftRef.current;
    if (!draft) return;
    if (!sessionRef.current) {
      askSignIn();
      return;
    }
    const workflow = resolveWorkflow(draft);
    if (workflow && !draft.workflow) draft.workflow = workflow;
    if (workflow && !announcedRef.current) {
      announcedRef.current = true;
      say(`Got it. This looks like ${workflowLabels[workflow].toLowerCase()}.`);
    }
    const step = planNextStep(draft);
    switch (step.type) {
      case "workflow": {
        const id = makeId("m");
        const options: UseCase[] = step.candidates.length
          ? step.candidates
          : ["data-analysis", "tax-notice", "msme-payment"];
        dispatch({
          type: "add",
          message: {
            id,
            from: "evianta",
            type: "workflow-choice",
            options,
          },
        });
        setAwaiting({ type: "workflow", messageId: id });
        return;
      }
      case "document": {
        const id = makeId("m");
        dispatch({
          type: "add",
          message: {
            id,
            from: "evianta",
            type: "missing-document",
            slotId: step.slot.id,
            label: step.slot.label,
            hint: step.slot.hint,
            skippable: step.slot.skippable,
          },
        });
        setAwaiting({ type: "slot", slotId: step.slot.id, messageId: id });
        return;
      }
      case "fact": {
        const id = makeId("m");
        dispatch({
          type: "add",
          message: {
            id,
            from: "evianta",
            type: "question",
            origin: "intake",
            questionId: step.fact.id,
            text: step.fact.question,
            chips: step.fact.chips,
            hint: step.fact.freeTextHint,
          },
        });
        setAwaiting({ type: "fact", fact: step.fact, messageId: id });
        return;
      }
      case "ready":
        setAwaiting(null);
        await startSetup(step.assignments);
    }
  };
  advanceRef.current = advance;

  useEffect(() => {
    if (session && pendingSignInRef.current) {
      pendingSignInRef.current = false;
      void advanceRef.current();
    }
  }, [session]);

  const resetForNewTask = () => {
    abortRef.current?.abort();
    draftRef.current = null;
    announcedRef.current = false;
    signInCardRef.current = false;
    pendingSignInRef.current = false;
    setupRef.current = { caseId: null, uploaded: new Set() };
    runQuestionsRef.current = null;
    retryRef.current = null;
    activeRunRef.current = null;
    setActiveRunId(null);
    setAwaiting(null);
    setBusy(false);
    if (window.location.search) window.history.replaceState(null, "", "/");
  };

  const newDraft = (prompt: string, files: AttachedFile[]): Draft => {
    const sample = sampleRef.current;
    sampleRef.current = null;
    return {
      prompt,
      files,
      workflow: sample?.case.useCase ?? null,
      answers: {},
      skippedSlots: [],
    };
  };

  const mergeIntoDraft = (content: string, files: AttachedFile[]) => {
    const draft = draftRef.current;
    if (!draft) return;
    if (files.length) draft.files = [...draft.files, ...files];
    if (content) {
      draft.prompt = draft.prompt ? `${draft.prompt}\n${content}` : content;
    }
  };

  const answerFact = (fact: FactSpec, messageId: string, answer: string) => {
    const draft = draftRef.current;
    if (!draft) return;
    draft.answers[fact.id] = answer;
    dispatch({ type: "patch", id: messageId, patch: { answered: answer } });
    setAwaiting(null);
    void advance();
  };

  const skipSlot = (messageId: string, slotId: string) => {
    const draft = draftRef.current;
    if (!draft) return;
    draft.skippedSlots.push(slotId);
    dispatch({ type: "patch", id: messageId, patch: { resolved: "skipped" } });
    setAwaiting(null);
    void advance();
  };

  async function submitMessage(rawText: string, attached: AttachedFile[]) {
    const content = rawText.trim();
    if (!content && !attached.length) return;
    if (busyRef.current || blockedRef.current) return;
    setComposerError(null);
    dispatch({
      type: "add",
      message: {
        id: makeId("m"),
        from: "user",
        text: content,
        files: attached.map(({ file }) => ({
          name: file.name,
          size: file.size,
        })),
      },
    });

    const awaiting = awaitingRef.current;
    if (!awaiting) {
      resetForNewTask();
      draftRef.current = newDraft(content, attached);
      if (!content) {
        say("What would you like me to do with these files?");
        setAwaiting({ type: "prompt" });
        return;
      }
      await advance();
      return;
    }
    switch (awaiting.type) {
      case "prompt":
        mergeIntoDraft(content, attached);
        setAwaiting(null);
        await advance();
        return;
      case "workflow": {
        mergeIntoDraft(content, attached);
        const draft = draftRef.current;
        const workflow = draft ? resolveWorkflow(draft) : null;
        if (workflow) {
          dispatch({
            type: "patch",
            id: awaiting.messageId,
            patch: { chosen: workflow },
          });
          setAwaiting(null);
          await advance();
        } else {
          say("I am still not sure. Please pick one of the options above.");
        }
        return;
      }
      case "slot": {
        const skipPhrase =
          /^(no|none|n\/a|skip|not available|i (do not|don'?t) have( it)?)\b/i;
        if (!attached.length && skipPhrase.test(content)) {
          const draft = draftRef.current;
          const slot = draft
            ? workflowSlots[resolveWorkflow(draft) ?? "data-analysis"].find(
                (item) => item.id === awaiting.slotId,
              )
            : undefined;
          if (slot?.skippable) {
            skipSlot(awaiting.messageId, awaiting.slotId);
            return;
          }
        }
        mergeIntoDraft(content, attached);
        if (attached.length) {
          dispatch({
            type: "patch",
            id: awaiting.messageId,
            patch: { resolved: "attached" },
          });
          setAwaiting(null);
          await advance();
        } else {
          say("Noted. I still need that file to continue.");
        }
        return;
      }
      case "fact":
        mergeIntoDraft("", attached);
        if (content) answerFact(awaiting.fact, awaiting.messageId, content);
        else {
          setAwaiting(null);
          await advance();
        }
        return;
      case "run-question":
        setComposerError(
          "Complete the questions in the form above to continue.",
        );
        return;
    }
  }

  // ------------------------------------------------------------- setup

  const failSetup = (
    messageId: string,
    stepId: string | null,
    reason: unknown,
    fallback: string,
  ) => {
    if (stepId) {
      dispatch({
        type: "step",
        id: messageId,
        stepId,
        patch: { status: "failed" },
      });
    }
    const caseId = setupRef.current.caseId;
    const message = errorText(reason, fallback);
    // A 4xx means nothing was stored, so resending into the same case is safe.
    const canRetry = !caseId || isRejected(reason);
    retryRef.current = () => void advanceRef.current();
    notice(
      "danger",
      caseId
        ? `${message} Your case is saved, and what finished is kept.`
        : message,
      canRetry || !caseId ? { kind: "retry" } : { kind: "open-case", caseId },
    );
    setBusy(false);
  };

  async function waitUntilReady(
    caseId: string,
    onTick?: (workspace: CaseWorkspace) => void,
  ): Promise<"ready" | "preparing"> {
    for (let attempt = 0; attempt < 45; attempt += 1) {
      const workspace = await apiRef.current.getCaseWorkspace(caseId);
      onTick?.(workspace);
      if (
        workspace.documents.some((item) =>
          ["failed", "partial"].includes(item.state),
        )
      ) {
        throw new Error(
          "A source document could not be fully read. Open the case to review it before continuing.",
        );
      }
      if (
        workspace.documents.length &&
        workspace.documents.every((item) => item.state === "ready")
      ) {
        return "ready";
      }
      await sleep(2000);
    }
    return "preparing";
  }

  async function startSetup(assignments: SlotAssignment[]) {
    const draft = draftRef.current;
    if (!draft) return;
    const workflow = resolveWorkflow(draft);
    if (!workflow) return;
    const api = apiRef.current;
    setBusy(true);

    for (const assignment of assignments) {
      const file = draft.files.find((item) => item.id === assignment.fileId);
      if (assignment.assumed && file) {
        say(
          `I will treat ${file.file.name} as ${assignment.slot.label}. Tell me if that is wrong.`,
        );
      }
    }

    const messageId = makeId("setup");
    const setup = setupRef.current;
    const steps: SetupStep[] = [
      {
        id: "case",
        label: "Creating your private case",
        status: setup.caseId ? "done" : "pending",
      },
      ...draft.files.map((item) => ({
        id: `file-${item.id}`,
        label: `Uploading ${item.file.name}`,
        status: (setup.uploaded.has(item.id)
          ? "done"
          : "pending") as StepStatus,
      })),
      {
        id: "ready",
        label: "Making sure every file is readable",
        status: "pending",
      },
      { id: "start", label: "Handing the work to the team", status: "pending" },
    ];
    dispatch({
      type: "add",
      message: { id: messageId, from: "evianta", type: "setup", steps },
    });
    const step = (stepId: string, patch: Partial<SetupStep>) =>
      dispatch({ type: "step", id: messageId, stepId, patch });
    let current: string | null = null;

    try {
      const config = configRef.current ?? (await api.getIntakeConfiguration());
      configRef.current = config;
      if (!config.workflows.includes(workflow)) {
        throw new Error("This workflow is not available for live work yet.");
      }
      if (draft.files.length > config.uploadMaxFiles) {
        throw new Error(
          `Please attach at most ${config.uploadMaxFiles} ${config.uploadMaxFiles === 1 ? "file" : "files"} for one task.`,
        );
      }
      const spec = workflowSpecs[workflow];
      const limits = { ...spec, ...limitsFor(config) };
      for (const item of draft.files) {
        const invalid = validateUploadFile(item.file, limits);
        if (invalid) throw new Error(`${item.file.name}: ${invalid}`);
      }
      const details = intakeCaseDetails(buildTaskDescription(draft), "");
      if (!details.success) {
        throw new Error(
          "Please keep the task description under 5,000 characters.",
        );
      }

      if (!setup.caseId) {
        current = "case";
        step("case", { status: "active" });
        try {
          const created = await api.createCase({
            ...details.data,
            useCase: workflow,
            sourceCaseId: sampleRef.current?.case.id ?? null,
          });
          setup.caseId = created.id;
        } catch (reason) {
          if (isStale(reason) || isRejected(reason)) throw reason;
          // Creation has no idempotency key, so never guess ownership of a similar case.
          block();
          let possible: string[] = [];
          try {
            const cases = await api.listCases();
            possible = cases
              .filter(
                (record) =>
                  record.title === details.data.title &&
                  record.useCase === workflow,
              )
              .map((record) => record.id);
          } catch {
            possible = [];
          }
          step("case", { status: "failed" });
          notice(
            "danger",
            "I could not confirm that your case was created, so I will not send it again. Check your cases before starting another task.",
            possible.length === 1
              ? { kind: "open-case", caseId: possible[0] as string }
              : { kind: "open-cases" },
          );
          setBusy(false);
          return;
        }
        step("case", { status: "done" });
      }
      const caseId = setup.caseId;
      window.history.replaceState(
        null,
        "",
        `/?case=${encodeURIComponent(caseId)}`,
      );

      for (const item of draft.files) {
        if (setup.uploaded.has(item.id)) continue;
        current = `file-${item.id}`;
        step(current, { status: "active", detail: "Uploading" });
        try {
          const document = await api.uploadDocument(caseId, item.file, "mixed");
          if (document.state === "failed" || document.state === "partial") {
            setup.uploaded.add(item.id);
            throw new Error(
              `${item.file.name} could not be fully read. Open the case to inspect it; successful uploads are kept.`,
            );
          }
        } catch (reason) {
          if (
            isStale(reason) ||
            setup.uploaded.has(item.id) ||
            isRejected(reason)
          ) {
            throw reason;
          }
          // The response was lost. Only continue if the document is provably stored.
          const stored = await api
            .getCaseWorkspace(caseId)
            .then((workspace) => {
              const same = (name: string, size: number) =>
                name === item.file.name && size === item.file.size;
              const alreadyConfirmed = draft.files.filter(
                (other) =>
                  other.id !== item.id &&
                  setup.uploaded.has(other.id) &&
                  same(other.file.name, other.file.size),
              ).length;
              const stored = workspace.documents.filter((entry) =>
                same(entry.name, entry.sizeBytes),
              ).length;
              return stored > alreadyConfirmed;
            })
            .catch(() => false);
          if (!aliveRef.current) return;
          if (!stored) {
            block();
            step(current, { status: "failed" });
            notice(
              "danger",
              `I could not confirm that ${item.file.name} was uploaded. Open the case to check before uploading again.`,
              { kind: "open-case", caseId },
            );
            setBusy(false);
            return;
          }
        }
        setup.uploaded.add(item.id);
        step(current, { status: "done", detail: undefined });
      }

      current = "ready";
      step("ready", { status: "active" });
      const readiness = await waitUntilReady(caseId);
      if (readiness === "preparing") {
        step("ready", {
          status: "failed",
          detail: "Still being prepared",
        });
        notice(
          "warning",
          "Your files are still being prepared. Open the case and start the analysis when they are ready.",
          { kind: "open-case", caseId },
        );
        setBusy(false);
        return;
      }
      step("ready", { status: "done" });

      current = "start";
      step("start", { status: "active" });
      let run: RunDto | null = null;
      try {
        run = await api.startRun(caseId);
      } catch (reason) {
        if (isStale(reason) || isRejected(reason)) throw reason;
        // A lost response can still mean the run was admitted.
        run = await api.getLatestRun(caseId).catch((lookup) => {
          if (isStale(lookup)) throw lookup;
          return null;
        });
        if (!run) {
          block();
          step("start", { status: "failed" });
          notice(
            "danger",
            `The run was not confirmed: ${errorText(reason, "Request failed.")} Open the case to check; I will not start it again.`,
            { kind: "open-case", caseId },
          );
          setBusy(false);
          return;
        }
      }
      step("start", { status: "done" });
      draftRef.current = null;
      setupRef.current = { caseId: null, uploaded: new Set() };
      await attachRun(caseId, run);
    } catch (reason) {
      if (isStale(reason)) return;
      failSetup(messageId, current, reason, "The task could not be started.");
    }
  }

  // --------------------------------------------------------------- run

  const scheduleRefresh = (caseId: string) => {
    if (refreshTimer.current) return;
    refreshTimer.current = window.setTimeout(() => {
      refreshTimer.current = null;
      void apiRef.current
        .getCaseWorkspace(caseId)
        .then((workspace) =>
          setWorkspaces((current) => ({ ...current, [caseId]: workspace })),
        )
        .catch(() => undefined);
    }, 800);
  };

  async function attachRun(caseId: string, run: RunDto, replay = false) {
    setBusy(true);
    activeRunRef.current = { caseId, runId: run.id };
    setActiveRunId(run.id);
    if (!progressRef.current[run.id]) {
      progressRef.current = {
        ...progressRef.current,
        [run.id]: createProgress(caseId, run),
      };
      setProgressMap(progressRef.current);
    }
    dispatch({
      type: "add",
      message: {
        id: `progress-${run.id}`,
        from: "evianta",
        type: "progress",
        runId: run.id,
      },
    });
    await follow(caseId, run.id, replay || isTerminalStatus(run.status));
  }

  async function follow(caseId: string, runId: string, replayOnly = false) {
    const api = apiRef.current;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      for (let round = 0; round < 30; round += 1) {
        await api.streamRunEvents(runId, {
          afterSequence: progressRef.current[runId]?.lastSequence ?? 0,
          caseId,
          replayOnly,
          signal: controller.signal,
          onEvent(event) {
            updateProgress(runId, (state) =>
              applyRunEvent(state, event, nameOf),
            );
            if (event.payload.type === "finding-added") scheduleRefresh(caseId);
          },
        });
        if (controller.signal.aborted) return;
        const latest = await api.getLatestRun(caseId);
        if (!latest || latest.id !== runId) break;
        if (!replayOnly && ["running", "queued"].includes(latest.status)) {
          await sleep(600);
          continue;
        }
        break;
      }
      if (controller.signal.aborted) return;
      await finalize(caseId, runId);
    } catch (reason) {
      if (controller.signal.aborted || isStale(reason)) return;
      retryRef.current = () => {
        setBusy(true);
        void follow(caseId, runId);
      };
      notice(
        "warning",
        `I lost the live connection: ${errorText(reason, "The progress stream disconnected.")} Your work is safe in the case.`,
        { kind: "open-case", caseId },
      );
      setBusy(false);
    }
  }

  async function finalize(caseId: string, runId: string) {
    const api = apiRef.current;
    const [workspace, latest] = await Promise.all([
      api.getCaseWorkspace(caseId),
      api.getLatestRun(caseId),
    ]);
    setWorkspaces((current) => ({ ...current, [caseId]: workspace }));
    const status = latest?.status ?? progressRef.current[runId]?.status;
    if (status) {
      updateProgress(runId, (state) => ({
        ...state,
        status: status as ProgressState["status"],
      }));
    }
    setBusy(false);

    if (status === "waiting-for-input") {
      const questions = pendingInputQuestions(workspace);
      if (!questions.length) {
        notice(
          "warning",
          "The team needs more information, but I could not load the questions. Open the case to answer them.",
          { kind: "open-case", caseId },
        );
        return;
      }
      const messageId = makeId("questions");
      dispatch({
        type: "add",
        message: {
          id: messageId,
          from: "evianta",
          type: "question-form",
          questions,
        },
      });
      runQuestionsRef.current = {
        caseId,
        runId,
        messageId,
        questions,
        uploaded: new Set(),
        answers: {},
        key: null,
      };
      setAwaiting({ type: "run-question" });
      return;
    }

    setAwaiting(null);
    if (status === "completed" || status === "partially-completed") {
      const summary = buildResult(workspace, latest ?? null);
      say(
        status === "completed"
          ? "Here is what I found. Select any item to look closer."
          : "Part of the work finished. Here is what is ready.",
      );
      setResultMap((current) => ({ ...current, [runId]: summary }));
      dispatch({
        type: "add",
        message: {
          id: `result-${runId}`,
          from: "evianta",
          type: "result",
          runId,
        },
      });
      if (status === "partially-completed") {
        retryRef.current = () => void retryRun(caseId, runId);
        notice(
          "warning",
          "Some steps did not finish. You can retry them, and finished work is kept.",
          { kind: "retry" },
        );
      }
      notice("info", "Ready for the next task whenever you are.", {
        kind: "new-task",
      });
      return;
    }
    if (status === "failed") {
      retryRef.current = () => void retryRun(caseId, runId);
      notice(
        "danger",
        "The run stopped before it finished. Retrying keeps the work that is already done.",
        { kind: "retry" },
      );
      return;
    }
    if (status === "cancelled") {
      notice("info", "Stopped. Finished work is kept in the case.", {
        kind: "open-case",
        caseId,
      });
      return;
    }
    if (status === "limit-reached") {
      notice(
        "warning",
        "A usage limit was reached. Finished work is kept in the case.",
        { kind: "open-case", caseId },
      );
    }
  }

  async function retryRun(caseId: string, runId: string) {
    setBusy(true);
    try {
      const retried = await apiRef.current.retryRun(runId);
      await attachRun(caseId, retried);
    } catch (reason) {
      if (isStale(reason)) return;
      retryRef.current = () => void retryRun(caseId, runId);
      notice(
        "danger",
        `The run could not be retried: ${errorText(reason, "Request failed.")}`,
        { kind: "retry" },
      );
      setBusy(false);
    }
  }

  // ----------------------------------------------- mid-run questions

  async function submitResume() {
    const rq = runQuestionsRef.current;
    if (!rq || busyRef.current) return;
    rq.key ??= makeId("resume");
    dispatch({ type: "patch", id: rq.messageId, patch: { error: null } });
    setBusy(true);
    try {
      await apiRef.current.resumeRun(rq.caseId, rq.runId, rq.answers, rq.key);
      dispatch({
        type: "patch",
        id: rq.messageId,
        patch: { submitted: true },
      });
      setAwaiting(null);
      runQuestionsRef.current = null;
      updateProgress(rq.runId, (state) => ({
        ...state,
        status: "running",
        waitingQuestionIds: [],
      }));
      await follow(rq.caseId, rq.runId);
    } catch (reason) {
      if (isStale(reason)) return;
      setAwaiting({ type: "run-question" });
      retryRef.current = () => void submitResume();
      dispatch({
        type: "patch",
        id: rq.messageId,
        patch: {
          error: `I could not pass your answers on: ${errorText(reason, "Request failed.")} Retry sending them below.`,
        },
      });
      setBusy(false);
    }
  }

  async function submitRunAnswers(
    messageId: string,
    answers: Record<string, string>,
    files: File[],
  ) {
    const rq = runQuestionsRef.current;
    if (!rq || rq.messageId !== messageId || busyRef.current) return;
    const showError = (error: string | null) =>
      dispatch({ type: "patch", id: messageId, patch: { error } });
    if (rq.key) {
      await submitResume();
      return;
    }
    if (rq.questions.some((question) => !answers[question.id]?.trim())) {
      showError("Answer every question in the form before continuing.");
      return;
    }
    const maxFiles = configRef.current?.uploadMaxFiles ?? 5;
    if (files.length > maxFiles) {
      showError(`Please attach at most ${maxFiles} files.`);
      return;
    }
    for (const file of files) {
      const error = validateUploadFile(file, limitsFor(configRef.current));
      if (error) {
        showError(error);
        return;
      }
    }
    showError(null);
    setBusy(true);
    try {
      for (const file of files) {
        if (rq.uploaded.has(file)) continue;
        await apiRef.current.uploadDocument(rq.caseId, file, "mixed");
        rq.uploaded.add(file);
      }
      if (files.length) await waitUntilReady(rq.caseId);
    } catch (reason) {
      if (isStale(reason)) return;
      setBusy(false);
      showError(
        `The file could not be added: ${errorText(reason, "Request failed.")}`,
      );
      return;
    }
    rq.answers = Object.fromEntries(
      rq.questions.map((question) => [
        question.id,
        {
          question: question.text,
          answer: [
            answers[question.id]!.trim(),
            files.length
              ? `Uploaded: ${files.map((file) => file.name).join(", ")}`
              : "",
          ]
            .filter(Boolean)
            .join(". "),
        },
      ]),
    );
    dispatch({
      type: "patch",
      id: messageId,
      patch: {
        answers: Object.fromEntries(
          Object.entries(rq.answers).map(([id, value]) => [id, value.answer]),
        ),
      },
    });
    setBusy(false);
    await submitResume();
  }

  // ----------------------------------------------------------- hydrate

  useEffect(() => {
    if (!initialCaseId || !session || hydratedRef.current === initialCaseId) {
      return;
    }
    hydratedRef.current = initialCaseId;
    void (async () => {
      const api = apiRef.current;
      setBusy(true);
      try {
        const [workspace, latest] = await Promise.all([
          api.getCaseWorkspace(initialCaseId),
          api.getLatestRun(initialCaseId),
        ]);
        setWorkspaces((current) => ({
          ...current,
          [initialCaseId]: workspace,
        }));
        dispatch({
          type: "add",
          message: {
            id: makeId("m"),
            from: "user",
            text: workspace.case.description,
            files: workspace.documents.map((item) => ({
              name: item.name,
              size: item.sizeBytes,
            })),
          },
        });
        say("Welcome back. Here is where this task stands.", false);
        if (!latest) {
          notice("info", "No work has started on this case yet.", {
            kind: "open-case",
            caseId: initialCaseId,
          });
          setBusy(false);
          return;
        }
        await attachRun(initialCaseId, latest, true);
      } catch (reason) {
        if (isStale(reason)) return;
        notice(
          "danger",
          `I could not open that case: ${errorText(reason, "Request failed.")}`,
          { kind: "open-cases" },
        );
        setBusy(false);
      }
    })();
    // attachRun and the other flow helpers only touch refs and stable setters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialCaseId, session]);

  // ----------------------------------------------------- composer glue

  const onFilesSelected = useCallback(
    async (selected: File[]) => {
      if (!selected.length) return;
      const config = configRef.current;
      const limit = config?.uploadMaxFiles ?? 10;
      const asCard = attachRequestRef.current;
      attachRequestRef.current = false;
      const limits = limitsFor(config);
      const invalid = selected
        .map((file) => validateUploadFile(file, limits))
        .find(Boolean);
      if (invalid) {
        setComposerError(invalid);
        return;
      }
      if (!asCard && composerFiles.length + selected.length > limit) {
        setComposerError(
          `Please attach at most ${limit} ${limit === 1 ? "file" : "files"} for one task.`,
        );
        return;
      }
      setComposerError(null);
      const placeholders = selected.map((file) => ({
        id: makeId("file"),
        file,
        status: "reading" as const,
      }));
      if (!asCard) setComposerFiles((current) => [...current, ...placeholders]);
      const read = await Promise.all(selected.map(readAttachment));
      if (asCard) {
        await submitMessage("", read);
        return;
      }
      setComposerFiles((current) =>
        current.map((entry) => {
          const index = placeholders.findIndex((item) => item.id === entry.id);
          const done = index >= 0 ? read[index] : undefined;
          return done ? { ...done, id: entry.id, status: "ready" } : entry;
        }),
      );
    },
    // submitMessage only uses refs and stable setters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [composerFiles.length],
  );

  const sendFromComposer = () => {
    const files: AttachedFile[] = composerFiles.map((entry) => ({
      id: entry.id,
      file: entry.file,
      header: entry.header,
      sample: entry.sample,
    }));
    const value = text;
    setText("");
    setComposerFiles([]);
    void submitMessage(value, files);
  };

  const handleNoticeAction = (action: NoticeAction) => {
    switch (action.kind) {
      case "open-case":
        router.push(`/cases/${encodeURIComponent(action.caseId)}`);
        return;
      case "open-cases":
        router.push("/cases");
        return;
      case "new-task":
        resetForNewTask();
        inputRef.current?.focus();
        return;
      case "retry":
        retryRef.current?.();
    }
  };

  const confirmStop = async () => {
    const active = activeRunRef.current;
    if (!active) return;
    try {
      await apiRef.current.cancelRun(active.runId);
    } catch (reason) {
      if (isStale(reason)) return;
      setComposerError(
        `The run could not be stopped: ${errorText(reason, "Request failed.")}`,
      );
    }
  };

  const context: MessageContext = {
    progressFor: (runId) => progressMap[runId] ?? null,
    resultFor: (runId) => resultMap[runId] ?? null,
    findingTitlesFor: (caseId) =>
      Object.fromEntries(
        (workspaces[caseId]?.findings ?? []).map((finding) => [
          finding.id,
          finding.title,
        ]),
      ),
    isActiveRun: (runId) => activeRunId === runId,
    busy,
    signedIn: Boolean(session),
    onSignIn: () => openAccessKeyDialog(),
    onChooseWorkflow: (messageId, workflow) => {
      const draft = draftRef.current;
      if (!draft || busyRef.current) return;
      draft.workflow = workflow;
      dispatch({
        type: "add",
        message: {
          id: makeId("m"),
          from: "user",
          text: workflowLabels[workflow],
          files: [],
        },
      });
      dispatch({ type: "patch", id: messageId, patch: { chosen: workflow } });
      setAwaiting(null);
      void advance();
    },
    onAttach: () => {
      attachRequestRef.current = true;
      filePickerRef.current?.click();
    },
    onSkipSlot: (messageId, slotId, label) => {
      dispatch({
        type: "add",
        message: {
          id: makeId("m"),
          from: "user",
          text: `I do not have ${label}.`,
          files: [],
        },
      });
      skipSlot(messageId, slotId);
    },
    onAnswer: (messageId, answer) => {
      const awaiting = awaitingRef.current;
      dispatch({
        type: "add",
        message: { id: makeId("m"), from: "user", text: answer, files: [] },
      });
      if (awaiting?.type === "fact" && awaiting.messageId === messageId) {
        answerFact(awaiting.fact, messageId, answer);
        return;
      }
    },
    questionFileAccept: acceptAttribute,
    onSubmitAnswers: submitRunAnswers,
    onStop: () => setStopOpen(true),
    onNoticeAction: handleNoticeAction,
    onInspect: (target, caseId) =>
      setInspect({
        target,
        caseId: caseId ?? activeRunRef.current?.caseId ?? null,
      }),
  };

  const empty = messages.length === 0;
  const composerDisabled = busy || blocked || awaitingKind === "run-question";
  const readingFiles = composerFiles.some((file) => file.status === "reading");
  const sendDisabled =
    composerDisabled ||
    readingFiles ||
    (!text.trim() && composerFiles.length === 0);
  const placeholder = blocked
    ? "Check your cases before starting another task."
    : busy
      ? "Evianta is working..."
      : awaitingKind === "run-question"
        ? "Complete the form above to continue."
        : (awaitingHint ?? examplePrompt);
  const inspectWorkspace = inspect?.caseId
    ? (workspaces[inspect.caseId] ?? null)
    : null;
  const localFiles = useMemo(
    () =>
      messages.flatMap((message) =>
        message.from === "user" ? message.files : [],
      ),
    [messages],
  );

  return (
    <section className="chat" aria-label="Chat with Evianta">
      {empty ? (
        <div className="chat-hero">
          <AgentAvatar role="coordinator" name="Evianta" size="xl" />
          <h1 className="chat-title">Hi, I am Evianta.</h1>
          <p className="chat-subtitle">
            Tell me what you need. Attach your records and I will ask only for
            what is missing, then bring in the specialists and report back here.
          </p>
          {sourceSample && (
            <p className="chat-sample-note">
              Starting from the workflow in &quot;{sourceSample.case.title}
              &quot;. Only its setup is copied; your files stay yours.
            </p>
          )}
        </div>
      ) : (
        <div
          className="chat-thread"
          role="log"
          aria-label="Conversation with Evianta"
          aria-live="polite"
          aria-relevant="additions"
        >
          {messages.map((message: ChatMessage) => (
            <MessageView key={message.id} message={message} context={context} />
          ))}
          <div ref={endRef} className="chat-end" />
        </div>
      )}

      <div className="chat-dock">
        {away && !empty && (
          <button
            type="button"
            className="jump-latest"
            onClick={() =>
              endRef.current?.scrollIntoView({
                block: "end",
                behavior: reducedMotion ? "auto" : "smooth",
              })
            }
          >
            <ArrowDown size={14} aria-hidden="true" /> Jump to latest
          </button>
        )}
        <Composer
          value={text}
          onChange={setText}
          files={composerFiles.map(({ id, file, status }) => ({
            id,
            name: file.name,
            size: file.size,
            status,
          }))}
          onRemoveFile={(id) =>
            setComposerFiles((current) =>
              current.filter((entry) => entry.id !== id),
            )
          }
          onFilesSelected={(files) => void onFilesSelected(files)}
          onSend={sendFromComposer}
          disabled={composerDisabled}
          sendDisabled={sendDisabled}
          placeholder={placeholder}
          accept={acceptAttribute}
          inputRef={inputRef}
          filePickerRef={filePickerRef}
          notice={composerError}
        />
        {empty && !text && (
          <ul className="suggestions" aria-label="Suggestions">
            {(Object.keys(starterPrompts) as UseCase[]).map((workflow) => {
              const Icon = suggestionIcons[workflow];
              return (
                <li key={workflow}>
                  <Chip
                    icon={<Icon size={14} aria-hidden="true" />}
                    tone="teal"
                    onClick={() => {
                      setText(starterPrompts[workflow]);
                      inputRef.current?.focus();
                    }}
                    title={starterPrompts[workflow]}
                  >
                    {workflowLabels[workflow]}
                  </Chip>
                </li>
              );
            })}
          </ul>
        )}
        <p className="chat-footnote">
          Evianta prepares work for professional review. It does not file,
          decide or give legal advice. Models may be used under your limits.
        </p>
      </div>

      {empty && children}

      <ChatInspector
        target={inspect?.target ?? null}
        onClose={() => setInspect(null)}
        onInspect={(target) =>
          setInspect((current) => ({
            target,
            caseId: current?.caseId ?? null,
          }))
        }
        workspace={inspectWorkspace}
        caseId={inspect?.caseId ?? null}
        profiles={profiles}
        localFiles={localFiles}
      />
      <ConfirmDialog
        open={stopOpen}
        onOpenChange={setStopOpen}
        title="Stop this task?"
        description="Work that is already finished stays in your case. You can retry the rest later."
        confirmLabel="Stop the task"
        destructive
        onConfirm={() => void confirmStop()}
      />
    </section>
  );
}

/** Starts a fresh conversation whenever the signed-in identity changes, so private content never carries over. */
export function ChatWorkspace(props: {
  sourceSample?: SyntheticWorkflowFixture;
  caseId?: string;
  children?: ReactNode;
}) {
  const { session } = useSession();
  const token = session?.accessToken ?? null;
  const previous = useRef(token);
  const [generation, setGeneration] = useState(0);
  if (previous.current !== token) {
    if (previous.current !== null) setGeneration((value) => value + 1);
    previous.current = token;
  }
  return <ChatSession key={generation} {...props} />;
}
