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
import type { UserProfile, WebApiClient } from "../api/client";
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
  profile: UserProfile | null;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const controller = useMemo(() => new SessionController(), []);
  const [restoring, setRestoring] = useState(true);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const generation = useRef(0);
  const pendingLogouts = useRef(
    new Map<string, { storageCleared: boolean; revoked: boolean }>(),
  );
  const [signingOut, setSigningOut] = useState(false);
  const [signOutPending, setSignOutPending] = useState(false);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [profileToken, setProfileToken] = useState<string | null>(null);
  const session = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    () => null,
  );
  const accessToken = session?.accessToken ?? null;
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
    if (!accessToken) return;
    let active = true;
    void api
      .getProfile()
      .then((result) => {
        if (!active) return;
        setProfile(result);
        setProfileToken(accessToken);
      })
      .catch(() => {
        if (active) setProfileToken(null);
      });
    return () => {
      active = false;
    };
  }, [api, accessToken]);

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
      profile: profileToken === session?.accessToken ? profile : null,
      restoring,
      restoreError,
      signingOut,
      signOutPending,
      api,
      async signIn(accessKey) {
        if (!accessKey.trim()) throw new Error("Enter an access key.");
        if (pendingLogouts.current.size > 0)
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
        const activeToken = controller.getToken();
        if (activeToken && !pendingLogouts.current.has(activeToken)) {
          pendingLogouts.current.set(activeToken, {
            storageCleared: false,
            revoked: false,
          });
        }
        if (pendingLogouts.current.size === 0) {
          setSignOutPending(false);
          return;
        }
        api.clearPrivateState();
        setSigningOut(true);
        setSignOutPending(true);
        try {
          const failures: string[] = [];
          while (pendingLogouts.current.size > 0) {
            const currentToken = controller.getToken();
            if (currentToken && !pendingLogouts.current.has(currentToken)) {
              pendingLogouts.current.set(currentToken, {
                storageCleared: false,
                revoked: false,
              });
            }

            for (const [token, state] of pendingLogouts.current) {
              if (state.storageCleared) continue;
              try {
                controller.clearIfToken(token);
                state.storageCleared = true;
              } catch (reason) {
                failures.push(
                  `Saved sign-in could not be removed: ${reason instanceof Error ? reason.message : "Browser storage is unavailable."}`,
                );
              }
            }

            for (const [token, state] of pendingLogouts.current) {
              if (state.revoked) continue;
              try {
                await api.revokeSession(token);
                state.revoked = true;
              } catch (reason) {
                failures.push(
                  `Server session could not be revoked: ${reason instanceof Error ? reason.message : "Request failed."}`,
                );
              }
            }

            for (const [token, state] of pendingLogouts.current) {
              if (state.storageCleared && state.revoked)
                pendingLogouts.current.delete(token);
            }

            const restoredToken = controller.getToken();
            if (
              restoredToken &&
              !pendingLogouts.current.has(restoredToken) &&
              failures.length === 0
            ) {
              pendingLogouts.current.set(restoredToken, {
                storageCleared: false,
                revoked: false,
              });
            }

            if (failures.length > 0) {
              const message = failures.join(" ");
              setRestoreError(message);
              throw new Error(message);
            }
          }

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
      profile,
      profileToken,
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
