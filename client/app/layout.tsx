import type { Metadata } from "next";
import Link from "next/link";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { ORG_IDS } from "@/lib/api";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Pollen Mesh",
  description: "Privacy-preserving, human-approved cross-org threat correlation.",
};

const NAV_LINKS = [
  { href: "/", label: "Mission Control" },
  { href: "/correlator", label: "Correlator" },
  { href: "/resolution", label: "Resolution" },
  { href: "/architecture", label: "Architecture" },
];

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col bg-zinc-50 text-zinc-900 dark:bg-black dark:text-zinc-50">
        <header className="border-b border-zinc-200 dark:border-zinc-800">
          <nav className="mx-auto flex max-w-5xl flex-wrap items-center gap-x-6 gap-y-2 px-6 py-4 text-sm">
            <span className="font-semibold tracking-tight">🌾 Pollen Mesh</span>
            <div className="flex flex-wrap gap-4">
              {NAV_LINKS.map((link) => (
                <Link
                  key={link.href}
                  href={link.href}
                  className="text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-50"
                >
                  {link.label}
                </Link>
              ))}
            </div>
            <div className="ml-auto flex gap-3 text-zinc-500">
              {ORG_IDS.map((id) => (
                <Link
                  key={id}
                  href={`/org/${id}`}
                  className="rounded border border-zinc-300 px-2 py-0.5 hover:border-zinc-500 hover:text-zinc-900 dark:border-zinc-700 dark:hover:border-zinc-500 dark:hover:text-zinc-50"
                >
                  {id}
                </Link>
              ))}
            </div>
          </nav>
        </header>
        <main className="flex flex-1 flex-col">{children}</main>
      </body>
    </html>
  );
}
