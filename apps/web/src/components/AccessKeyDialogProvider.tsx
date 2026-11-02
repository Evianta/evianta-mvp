"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import * as Dialog from "@radix-ui/react-dialog";
import {
  Eye,
  EyeOff,
  KeyRound,
  LoaderCircle,
  LockKeyhole,
  X,
} from "lucide-react";
import { Button } from "./Button";
import { useSession } from "../session/SessionProvider";

interface AccessKeyDialogContextValue {
  openAccessKeyDialog: (onSuccess?: () => void) => void;
}

const AccessKeyDialogContext =
  createContext<AccessKeyDialogContextValue | null>(null);

export function AccessKeyDialogProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [accessKey, setAccessKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [reveal, setReveal] = useState(false);
  const successCallback = useRef<(() => void) | undefined>(undefined);
  const { signIn, restoring, session } = useSession();
  const linkHandled = useRef(false);

  const openAccessKeyDialog = useCallback((onSuccess?: () => void) => {
    successCallback.current = onSuccess;
    setError(null);
    setOpen(true);
  }, []);

  // A shared link like /#access=<code> signs in once. The fragment never reaches the server and is removed from the address bar immediately.
  useEffect(() => {
    if (restoring || linkHandled.current) return;
    linkHandled.current = true;
    const match = /^#access=(.+)$/.exec(window.location.hash);
    if (!match?.[1]) return;
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${window.location.search}`,
    );
    if (session) return;
    let code: string;
    try {
      code = decodeURIComponent(match[1]);
    } catch {
      setError("That sign-in link is not valid.");
      setOpen(true);
      return;
    }
    setPending(true);
    void signIn(code)
      .catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : "Sign-in failed.");
        setOpen(true);
      })
      .finally(() => setPending(false));
  }, [restoring, session, signIn]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const submittedKey = accessKey;
    setAccessKey("");
    setError(null);
    setPending(true);
    try {
      await signIn(submittedKey);
      setOpen(false);
      successCallback.current?.();
      successCallback.current = undefined;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Sign-in failed.");
    } finally {
      setPending(false);
    }
  }

  return (
    <AccessKeyDialogContext.Provider value={{ openAccessKeyDialog }}>
      {children}
      <Dialog.Root
        open={open}
        onOpenChange={(nextOpen) => {
          if (pending) return;
          setOpen(nextOpen);
          if (!nextOpen) {
            setAccessKey("");
            setReveal(false);
            setError(null);
            successCallback.current = undefined;
          }
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="dialog-overlay" />
          <Dialog.Content
            className="dialog-content"
            aria-describedby="access-key-description"
          >
            <div className="flex items-start justify-between gap-5">
              <div className="flex items-start gap-3">
                <span className="icon-tile icon-tile-teal">
                  <LockKeyhole size={19} aria-hidden="true" />
                </span>
                <div>
                  <Dialog.Title className="text-lg font-semibold">
                    Sign in securely
                  </Dialog.Title>
                  <Dialog.Description
                    id="access-key-description"
                    className="mt-1 text-sm text-muted-foreground"
                  >
                    Your key is never saved. This browser saves your session
                    token to keep you signed in across reloads until the session
                    expires or you sign out.
                  </Dialog.Description>
                </div>
              </div>
              <Dialog.Close asChild>
                <button
                  type="button"
                  className="icon-button -mr-2 -mt-2"
                  aria-label="Close sign-in dialog"
                >
                  <X size={18} aria-hidden="true" />
                </button>
              </Dialog.Close>
            </div>
            <form className="mt-6 space-y-4" onSubmit={submit}>
              <label className="field-label" htmlFor="access-key">
                Access key
              </label>
              <div className="input-with-icon">
                <KeyRound size={17} aria-hidden="true" />
                <input
                  id="access-key"
                  className="text-input"
                  type={reveal ? "text" : "password"}
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  value={accessKey}
                  onChange={(event) => setAccessKey(event.target.value)}
                  required
                />
                <button
                  type="button"
                  className="icon-button input-trailing"
                  aria-label={reveal ? "Hide characters" : "Show characters"}
                  aria-pressed={reveal}
                  onClick={() => setReveal((current) => !current)}
                >
                  {reveal ? (
                    <EyeOff size={16} aria-hidden="true" />
                  ) : (
                    <Eye size={16} aria-hidden="true" />
                  )}
                </button>
              </div>
              {error && (
                <p className="text-sm text-danger" role="alert">
                  {error}
                </p>
              )}
              <Button
                className="w-full"
                type="submit"
                disabled={pending || !accessKey.trim()}
              >
                {pending ? (
                  <LoaderCircle className="animate-spin" size={17} />
                ) : null}
                Continue
              </Button>
              <p className="text-xs leading-relaxed text-muted-foreground">
                Your session lasts a limited time. After it ends, or when you
                sign out, enter your key again.
              </p>
            </form>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </AccessKeyDialogContext.Provider>
  );
}

export function useAccessKeyDialog(): AccessKeyDialogContextValue {
  const value = useContext(AccessKeyDialogContext);
  if (!value) {
    throw new Error("useAccessKeyDialog must be used inside its provider.");
  }
  return value;
}
