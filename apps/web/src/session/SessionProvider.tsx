"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { FetchWebApiClient } from "../api/client";
import type { WebApiClient } from "../api/client";
import {
  SESSION_STORAGE_KEY,
  SessionController,
  type ActiveSession,
} from "./session-controller";

interface SessionContextValue {
  session: ActiveSession | null;
  restoring: boolean;
  restoreError: string | null;
  signingOut: boolean;
  signOutPending: boolean;
  api: WebApiClient & {
    exchangeAccessKey: FetchWebApiClient["exchangeAccessKey"];
    revokeSession: FetchWebApiClient["revokeSession"];
  };
  signIn: (accessKey: string) => Promise<void>;
  signOut: () => Promise<void>;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const controller = useMemo(() => new SessionController(), []);
  const [restoring, setRestoring] = useState(true);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const generation = useRef(0);
  const logoutToken = useRef<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  const [signOutPending, setSignOutPending] = useState(false);
  const session = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    () => null,
  );
  const clearSession = useCallback(() => {
    try {
      controller.clear();
    } catch (reason) {
      setRestoreError(
        `Saved sign-in could not be removed. It may return on reload: ${reason instanceof Error ? reason.message : "Browser storage is unavailable."}`,
      );
    }
  }, [controller]);
  const api = useMemo(
    () =>
      new FetchWebApiClient({
        getToken: () => controller.getToken(),
        onUnauthorized: clearSession,
        baseUrl: process.env.NEXT_PUBLIC_API_BASE_URL,
      }),
    [controller, clearSession],
  );

  useEffect(() => {
    function restore() {
      generation.current++;
      api.clearPrivateState();
      setRestoreError(null);
      try {
        controller.restore(window.localStorage);
      } catch (reason) {
        setRestoreError(
          `Sign-in could not be restored: ${reason instanceof Error ? reason.message : "Browser storage is unavailable."}`,
        );
      } finally {
        setRestoring(false);
      }
    }
    function onStorage(event: StorageEvent) {
      if (
        event.storageArea === window.localStorage &&
        (event.key === SESSION_STORAGE_KEY || event.key === null)
      )
        restore();
    }
    restore();
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener("storage", onStorage);
    };
  }, [api, controller]);

  useEffect(() => {
    if (!session) return;
    const timer = window.setTimeout(
      () => {
        api.clearPrivateState();
        clearSession();
      },
      Math.max(0, session.expiresAt - Date.now()),
    );
    return () => window.clearTimeout(timer);
  }, [api, clearSession, session]);

  const value = useMemo<SessionContextValue>(
    () => ({
      session,
      restoring,
      restoreError,
      signingOut,
      signOutPending,
      api,
      async signIn(accessKey) {
        if (!accessKey.trim()) throw new Error("Enter an access key.");
        if (logoutToken.current)
          throw new Error(
            "Finish signing out before entering another access key.",
          );
        const version = ++generation.current;
        setRestoring(false);
        setRestoreError(null);
        api.clearPrivateState();
        const token = await api.exchangeAccessKey(accessKey);
        if (generation.current === version) {
          try {
            controller.setSession(
              token.accessToken,
              Date.parse(token.expiresAt),
              window.localStorage,
            );
          } catch (reason) {
            throw new Error(
              `Sign-in could not be saved in this browser: ${reason instanceof Error ? reason.message : "Browser storage is unavailable."}`,
              { cause: reason },
            );
          }
        }
      },
      async signOut() {
        if (signingOut) return;
        generation.current++;
        setRestoring(false);
        setRestoreError(null);
        const token = logoutToken.current ?? controller.getToken();
        logoutToken.current = token;
        api.clearPrivateState();
        setSigningOut(true);
        setSignOutPending(true);
        try {
          controller.clear();
          if (token) await api.revokeSession(token);
          logoutToken.current = null;
          setSignOutPending(false);
        } finally {
          setSigningOut(false);
        }
      },
    }),
    [
      api,
      controller,
      session,
      restoring,
      restoreError,
      signingOut,
      signOutPending,
    ],
  );

  return (
    <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
  );
}

export function useSession(): SessionContextValue {
  const value = useContext(SessionContext);
  if (!value)
    throw new Error("useSession must be used inside SessionProvider.");
  return value;
}
