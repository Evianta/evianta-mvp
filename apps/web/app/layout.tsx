import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import type { ReactNode } from "react";
import { AccessKeyDialogProvider } from "../src/components/AccessKeyDialogProvider";
import { AppShell } from "../src/components/AppShell";
import { ThemeProvider } from "../src/components/ThemeProvider";
import { SessionProvider } from "../src/session/SessionProvider";
import "./globals.css";
import "./workspace.css";

const geist = Geist({
  subsets: ["latin"],
  variable: "--font-geist-sans",
  display: "swap",
});

const geistMono = Geist_Mono({
  subsets: ["latin"],
  variable: "--font-geist-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Evianta — Evidence Atlas",
  description:
    "A calm, source-first workspace for turning business records into clear, reviewable findings.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className={`${geist.variable} ${geistMono.variable}`}>
        <ThemeProvider>
          <SessionProvider>
            <AccessKeyDialogProvider>
              <AppShell>{children}</AppShell>
            </AccessKeyDialogProvider>
          </SessionProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
