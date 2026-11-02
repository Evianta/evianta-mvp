"use client";

import Link from "next/link";
import Image from "next/image";
import { usePathname } from "next/navigation";
import {
  ChartNoAxesCombined,
  Files,
  FlaskConical,
  LogOut,
  MessageSquareText,
  ShieldCheck,
  UsersRound,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { useAccessKeyDialog } from "./AccessKeyDialogProvider";
import { Button } from "./Button";
import { CommandPalette } from "./CommandPalette";
import { ThemeToggle } from "./ThemeToggle";
import { useSession } from "../session/SessionProvider";

const navigation = [
  { href: "/", label: "Start", icon: MessageSquareText, match: "home" },
  { href: "/cases", label: "Cases", icon: Files, match: "/cases" },
  {
    href: "/agents",
    label: "AI professionals",
    icon: UsersRound,
    match: "/agents",
  },
  { href: "/samples", label: "Samples", icon: FlaskConical, match: "/samples" },
  {
    href: "/admin/usage",
    label: "Usage overview",
    icon: ChartNoAxesCombined,
    match: "/admin/usage",
    adminOnly: true,
  },
];

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const {
    session,
    profile,
    signOut,
    restoring,
    restoreError,
    signingOut,
    signOutPending,
  } = useSession();
  const { openAccessKeyDialog } = useAccessKeyDialog();
  const [authError, setAuthError] = useState<string | null>(null);

  async function handleSignOut() {
    setAuthError(null);
    try {
      await signOut();
    } catch (reason) {
      setAuthError(
        reason instanceof Error
          ? `Sign-out could not finish: ${reason.message} Retry sign-out to remove saved login and revoke the session.`
          : "Sign-out could not finish. Retry sign-out to remove saved login and revoke the session.",
      );
    }
  }

  return (
    <div className="app-frame">
      <aside className="sidebar" aria-label="Primary navigation">
        <Link className="brand-lockup" href="/">
          <Image src="/logo.svg" alt="" width={36} height={36} priority />
          <span>
            <span className="brand-name block">evianta</span>
            <span className="brand-subtitle block">Evidence Atlas</span>
          </span>
        </Link>
        <p className="nav-caption">Workspace</p>
        <nav className="sidebar-nav">
          {navigation
            .filter((item) => !item.adminOnly || profile?.role === "admin")
            .map((item) => {
              const active =
                item.match === "home"
                  ? pathname === "/"
                  : item.match === "/cases"
                    ? pathname === "/cases" || /^\/cases\/[^/]+$/.test(pathname)
                    : pathname === item.match ||
                      pathname.startsWith(`${item.match}/`);
              const Icon = item.icon;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className="nav-link"
                  aria-current={active ? "page" : undefined}
                >
                  <Icon size={17} strokeWidth={1.8} aria-hidden="true" />
                  {item.label}
                </Link>
              );
            })}
        </nav>
        <div className="sidebar-bottom">
          <p className="privacy-note">
            <ShieldCheck
              size={15}
              className="mt-0.5 shrink-0 text-primary"
              aria-hidden="true"
            />
            Private work stays in your session. Public samples contain synthetic
            data.
          </p>
        </div>
      </aside>

      <div className="app-main">
        <header className="topbar">
          <p className="topbar-context">
            {pathname.startsWith("/samples/")
              ? "Synthetic replay"
              : pathname.startsWith("/cases")
                ? "Private workspace"
                : pathname.startsWith("/admin")
                  ? "Administration"
                  : "Evidence, clearly connected"}
          </p>
          <div className="topbar-actions">
            <CommandPalette />
            <ThemeToggle />
            {session || signOutPending ? (
              <Button
                variant="secondary"
                size="sm"
                onClick={handleSignOut}
                aria-label="Sign out and revoke this session"
                disabled={signingOut}
              >
                <LogOut size={15} aria-hidden="true" />
                {signingOut
                  ? "Signing out..."
                  : signOutPending
                    ? "Retry sign-out"
                    : "Sign out"}
              </Button>
            ) : (
              <Button
                size="sm"
                disabled={restoring}
                onClick={() => openAccessKeyDialog()}
              >
                {restoring ? "Restoring sign-in..." : "Sign in"}
              </Button>
            )}
          </div>
        </header>
        {restoreError && (
          <p
            className="border-b border-warning/30 bg-warning/10 px-6 py-2 text-center text-xs text-warning"
            role="status"
          >
            {restoreError}
          </p>
        )}
        {authError && (
          <div
            className="border-b border-warning/30 bg-warning/10 px-6 py-2 text-center text-xs text-warning"
            role="status"
          >
            {authError}
          </div>
        )}
        <main id="main-content" className="page-content">
          {children}
        </main>
      </div>
    </div>
  );
}
