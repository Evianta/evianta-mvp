"use client";

import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type KeyboardEvent,
  type RefObject,
} from "react";
import {
  ArrowUp,
  CircleCheck,
  FileUp,
  LoaderCircle,
  Plus,
  X,
} from "lucide-react";
import { formatFileSize } from "../intake";
import { SourcesMenu } from "./SourcesMenu";

export interface ComposerFile {
  id: string;
  name: string;
  size: number;
  status: "reading" | "ready";
}

export function Composer({
  value,
  onChange,
  files,
  onRemoveFile,
  onFilesSelected,
  onSend,
  disabled,
  sendDisabled,
  placeholder,
  accept,
  inputRef,
  filePickerRef,
  notice,
}: {
  value: string;
  onChange: (value: string) => void;
  files: ComposerFile[];
  onRemoveFile: (id: string) => void;
  onFilesSelected: (files: File[]) => void;
  onSend: () => void;
  disabled: boolean;
  sendDisabled: boolean;
  placeholder: string;
  accept: string;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  filePickerRef: RefObject<HTMLInputElement | null>;
  notice?: string | null;
}) {
  const composing = useRef(false);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    const field = inputRef.current;
    if (!field) return;
    field.style.height = "auto";
    field.style.height = `${Math.min(field.scrollHeight, 220)}px`;
  }, [value, inputRef]);

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing &&
      !composing.current &&
      event.nativeEvent.keyCode !== 229
    ) {
      event.preventDefault();
      if (!sendDisabled) onSend();
    }
  }

  function onDrop(event: DragEvent<HTMLFormElement>) {
    event.preventDefault();
    setDragging(false);
    if (disabled) return;
    onFilesSelected(Array.from(event.dataTransfer.files));
  }

  function onPick(event: ChangeEvent<HTMLInputElement>) {
    onFilesSelected(Array.from(event.target.files ?? []));
    event.target.value = "";
  }

  const openPicker = () => filePickerRef.current?.click();

  return (
    <form
      className="composer"
      data-dragging={dragging ? "true" : undefined}
      onSubmit={(event) => {
        event.preventDefault();
        if (!sendDisabled) onSend();
      }}
      onDragOver={(event) => {
        event.preventDefault();
        if (!disabled) setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      {files.length > 0 && (
        <ul className="composer-files" aria-label="Attached files">
          {files.map((file) => (
            <li className="composer-file" key={file.id}>
              {file.status === "ready" ? (
                <CircleCheck
                  size={14}
                  className="text-success"
                  aria-hidden="true"
                />
              ) : (
                <LoaderCircle
                  size={14}
                  className="animate-spin text-muted-foreground"
                  aria-hidden="true"
                />
              )}
              <span className="composer-file-name" title={file.name}>
                {file.name}
              </span>
              <span className="composer-file-state">
                {file.status === "ready"
                  ? formatFileSize(file.size)
                  : "Reading"}
              </span>
              <button
                type="button"
                className="composer-file-remove"
                aria-label={`Remove ${file.name}`}
                onClick={() => onRemoveFile(file.id)}
                disabled={disabled}
              >
                <X size={13} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <label htmlFor="task-prompt" className="sr-only">
        Message to Evianta
      </label>
      <textarea
        ref={inputRef}
        id="task-prompt"
        className="composer-input"
        rows={2}
        value={value}
        disabled={disabled}
        placeholder={placeholder}
        maxLength={5000}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onKeyDown}
        onCompositionStart={() => {
          composing.current = true;
        }}
        onCompositionEnd={() => {
          composing.current = false;
        }}
      />
      {notice && (
        <p className="composer-notice" role="alert">
          {notice}
        </p>
      )}
      <div className="composer-toolbar">
        <button
          type="button"
          className="composer-plus"
          aria-label="Add files"
          disabled={disabled}
          onClick={openPicker}
        >
          <Plus size={18} aria-hidden="true" />
        </button>
        <SourcesMenu disabled={disabled} onUploadInstead={openPicker} />
        <button
          type="button"
          className="composer-pill"
          disabled={disabled}
          onClick={openPicker}
        >
          <FileUp size={15} aria-hidden="true" /> Files
        </button>
        <input
          ref={filePickerRef}
          type="file"
          multiple
          className="sr-only"
          aria-label="Attach records"
          accept={accept}
          disabled={disabled}
          onChange={onPick}
          tabIndex={-1}
        />
        <span className="composer-count" aria-hidden="true">
          {value.length > 4000 ? `${value.length}/5000` : ""}
        </span>
        <button
          type="submit"
          className="composer-send"
          aria-label="Send message"
          disabled={sendDisabled}
        >
          <ArrowUp size={18} aria-hidden="true" />
        </button>
      </div>
    </form>
  );
}
