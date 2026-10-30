"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Activity,
  ChartNoAxesCombined,
  FilePlus2,
  Files,
  Layers3,
  LogOut,
  ShieldCheck,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { useAccessKeyDialog } from "./AccessKeyDialogProvider";
import { Button } from "./Button";
import { CommandPalette } from "./CommandPalette";
import { ThemeToggle } from "./ThemeToggle";
import { useSession } from "../session/SessionProvider";

const navigation = [
  { href: "/", label: "Start", icon: Layers3, match: "home" },
  { href: "/cases", label: "Cases", icon: Files, match: "/cases" },
  {
    href: "/cases/new",
    label: "New task",
    icon: FilePlus2,
    match: "/cases/new",
  },
  { href: "/#samples", label: "Samples", icon: Layers3, match: "/samples" },
  {
    href: "/admin/usage",
    label: "Usage overview",
    icon: ChartNoAxesCombined,
    match: "/admin/usage",
  },
];

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { session, signOut } = useSession();
  const { openAccessKeyDialog } = useAccessKeyDialog();
  const [authError, setAuthError] = useState<string | null>(null);

  async function handleSignOut() {
    setAuthError(null);
    try {
      await signOut();
    } catch (reason) {
      setAuthError(
        reason instanceof Error
          ? `Signed out locally; server revocation failed: ${reason.message}`
          : "Signed out locally; server revocation failed.",
      );
    }
  }

  return (
    <div className="app-frame">
      <aside className="sidebar" aria-label="Primary navigation">
        <Link className="brand-lockup" href="/">
          <span className="brand-mark">
            <Activity size={19} strokeWidth={2.2} aria-hidden="true" />
          </span>
          <span>
            <span className="brand-name block">evianta</span>
            <span className="brand-subtitle block">Evidence Atlas</span>
          </span>
        </Link>
        <p className="nav-caption">Workspace</p>
        <nav className="sidebar-nav">
          {navigation.map((item) => {
            const active =
              item.match === "home"
                ? pathname === "/"
                : item.match === "/cases"
                  ? pathname === "/cases" ||
                    (/^\/cases\/[^/]+$/.test(pathname) &&
                      pathname !== "/cases/new")
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
            {session ? (
              <Button
                variant="secondary"
                size="sm"
                onClick={handleSignOut}
                aria-label="Sign out and revoke this session"
              >
                <LogOut size={15} aria-hidden="true" />
                Sign out
              </Button>
            ) : (
              <Button size="sm" onClick={() => openAccessKeyDialog()}>
                Sign in
              </Button>
            )}
          </div>
        </header>
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
