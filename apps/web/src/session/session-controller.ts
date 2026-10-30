export const MAX_SESSION_AGE_MS = 30 * 60 * 1000;
export const SESSION_STORAGE_KEY = "evianta.session";

type SessionStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export interface ActiveSession {
  accessToken: string;
  expiresAt: number;
}

export class SessionController {
  private session: ActiveSession | null = null;
  private readonly listeners = new Set<() => void>();
  private storage: SessionStorage | undefined;

  constructor(private readonly now: () => number = Date.now) {}

  restore(storage: SessionStorage): void {
    this.storage = storage;
    this.session = null;
    this.notify();
    const saved = storage.getItem(SESSION_STORAGE_KEY);
    if (saved === null) return;
    let value: unknown;
    try {
      value = JSON.parse(saved);
    } catch {
      storage.removeItem(SESSION_STORAGE_KEY);
      throw new Error("Saved sign-in is invalid. Enter your access key again.");
    }
    if (
      typeof value !== "object" ||
      value === null ||
      !("accessToken" in value) ||
      typeof value.accessToken !== "string" ||
      !value.accessToken.trim() ||
      !("expiresAt" in value) ||
      typeof value.expiresAt !== "number" ||
      !Number.isFinite(value.expiresAt) ||
      value.expiresAt > this.now() + MAX_SESSION_AGE_MS
    ) {
      storage.removeItem(SESSION_STORAGE_KEY);
      throw new Error("Saved sign-in is invalid. Enter your access key again.");
    }
    if (value.expiresAt <= this.now()) {
      storage.removeItem(SESSION_STORAGE_KEY);
      return;
    }
    this.session = {
      accessToken: value.accessToken,
      expiresAt: value.expiresAt,
    };
    this.notify();
  }

  readonly getSnapshot = (): ActiveSession | null => {
    if (this.session && this.session.expiresAt <= this.now()) return null;
    return this.session;
  };

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getToken(): string | null {
    const current = this.getSnapshot();
    if (!current && this.session) this.clear();
    return current?.accessToken ?? null;
  }

  setSession(
    accessToken: string,
    expiresAt: number,
    storage?: SessionStorage,
  ): void {
    if (storage) this.storage = storage;
    if (!accessToken.trim() || !Number.isFinite(expiresAt)) {
      throw new Error("A valid access token and expiry are required.");
    }
    const maximumExpiry = this.now() + MAX_SESSION_AGE_MS;
    const effectiveExpiry = Math.min(expiresAt, maximumExpiry);
    if (effectiveExpiry <= this.now()) {
      throw new Error("The access token is already expired.");
    }
    const session = { accessToken, expiresAt: effectiveExpiry };
    this.storage?.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
    this.session = session;
    this.notify();
  }

  clear(): void {
    this.session = null;
    this.notify();
    this.storage?.removeItem(SESSION_STORAGE_KEY);
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}
