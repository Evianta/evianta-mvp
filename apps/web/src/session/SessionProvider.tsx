"use client";

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { FetchWebApiClient } from "../api/client";
import type { WebApiClient } from "../api/client";
import { SessionController, type ActiveSession } from "./session-controller";

interface SessionContextValue {
  session: ActiveSession | null;
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
  const session = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    () => null,
  );
  const api = useMemo(
    () =>
      new FetchWebApiClient({
        getToken: () => controller.getToken(),
        onUnauthorized: () => controller.clear(),
        baseUrl: process.env.NEXT_PUBLIC_API_BASE_URL,
      }),
    [controller],
  );

  useEffect(() => {
    if (!session) return;
    const timer = window.setTimeout(
      () => {
        api.clearPrivateState();
        controller.clear();
      },
      Math.max(0, session.expiresAt - Date.now()),
    );
    return () => window.clearTimeout(timer);
  }, [api, controller, session]);

  const value = useMemo<SessionContextValue>(
    () => ({
      session,
      api,
      async signIn(accessKey) {
        if (!accessKey.trim()) throw new Error("Enter an access key.");
        api.clearPrivateState();
        const token = await api.exchangeAccessKey(accessKey);
        controller.setSession(token.accessToken, Date.parse(token.expiresAt));
      },
      async signOut() {
        const token = controller.getToken();
        if (!token) {
          api.clearPrivateState();
          return;
        }
        try {
          await api.revokeSession(token);
        } finally {
          api.clearPrivateState();
          controller.clear();
        }
      },
    }),
    [api, controller, session],
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
