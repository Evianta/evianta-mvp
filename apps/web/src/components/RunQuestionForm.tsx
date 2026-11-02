"use client";

import { useState } from "react";
import { Button } from "./Button";

export function RunQuestionForm({
  messageId,
  questions,
  answers: savedAnswers,
  submitted,
  busy,
  error,
  accept,
  onSubmit,
}: {
  messageId: string;
  questions: { id: string; text: string }[];
  answers?: Record<string, string>;
  submitted?: boolean;
  busy: boolean;
  error?: string | null;
  accept: string;
  onSubmit: (answers: Record<string, string>, files: File[]) => Promise<void>;
}) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [files, setFiles] = useState<File[]>([]);
  const values = savedAnswers ?? answers;
  const complete = questions.every((question) => values[question.id]?.trim());

  return (
    <form
      className="card-inline space-y-4"
      aria-label="Details needed to continue"
      onSubmit={(event) => {
        event.preventDefault();
        if (!complete || busy || submitted) return;
        void onSubmit(values, files);
      }}
    >
      <p className="msg-text">
        Answer each question, then submit the form to continue.
      </p>
      {questions.map((question, index) => {
        const id = `${messageId}-answer-${index}`;
        return (
          <div key={question.id} className="space-y-2">
            <label htmlFor={id} className="block text-sm font-medium">
              {question.text}
            </label>
            <textarea
              id={id}
              className="w-full rounded-lg border border-border bg-surface p-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              rows={3}
              required
              readOnly={Boolean(savedAnswers)}
              disabled={busy}
              value={values[question.id] ?? ""}
              onChange={(event) =>
                setAnswers((current) => ({
                  ...current,
                  [question.id]: event.target.value,
                }))
              }
            />
          </div>
        );
      })}
      {!savedAnswers && (
        <div className="space-y-2">
          <label
            htmlFor={`${messageId}-files`}
            className="block text-sm font-medium"
          >
            Supporting files (optional)
          </label>
          <input
            id={`${messageId}-files`}
            type="file"
            multiple
            accept={accept}
            disabled={busy}
            className="block w-full text-sm"
            onChange={(event) => setFiles(Array.from(event.target.files ?? []))}
          />
        </div>
      )}
      {error && (
        <p className="text-sm text-danger" role="alert">
          {error}
        </p>
      )}
      {submitted ? (
        <p className="text-sm text-success" role="status">
          Answers sent. The team can continue.
        </p>
      ) : (
        <Button type="submit" disabled={!complete || busy}>
          {busy
            ? "Sending answers..."
            : savedAnswers
              ? "Retry sending answers"
              : "Submit answers and continue"}
        </Button>
      )}
    </form>
  );
}
