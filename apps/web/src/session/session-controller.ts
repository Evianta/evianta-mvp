export const MAX_SESSION_AGE_MS = 30 * 60 * 1000;

export interface ActiveSession {
  accessToken: string;
  expiresAt: number;
}

export class SessionController {
  private session: ActiveSession | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly now: () => number = Date.now) {}

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

  setSession(accessToken: string, expiresAt: number): void {
    if (!accessToken.trim() || !Number.isFinite(expiresAt)) {
      throw new Error("A valid access token and expiry are required.");
    }
    const maximumExpiry = this.now() + MAX_SESSION_AGE_MS;
    const effectiveExpiry = Math.min(expiresAt, maximumExpiry);
    if (effectiveExpiry <= this.now()) {
      throw new Error("The access token is already expired.");
    }
    this.session = { accessToken, expiresAt: effectiveExpiry };
    this.notify();
  }

  clear(): void {
    if (!this.session) return;
    this.session = null;
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}
