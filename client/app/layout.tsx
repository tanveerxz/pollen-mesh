import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Nav } from "@/components/nav";
import { Presenter } from "@/components/presenter";
import { SystemProvider } from "@/lib/system-context";
import { DemoProvider } from "@/lib/demo-context";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Pollen Mesh",
  description:
    "Cross-organisation threat correlation with local reasoning, deterministic matching, and human approval before anything crosses a boundary.",
};

// Applies the stored theme before first paint so there is no flash of the wrong one.
const THEME_SCRIPT = `try{var t=localStorage.getItem("pollen.theme");if(t){document.documentElement.dataset.theme=t}}catch(e){}`;

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className="grid-bg flex min-h-full flex-col">
        <SystemProvider>
          <DemoProvider>
            <Nav />
            <main className="flex flex-1 flex-col">{children}</main>
            <Presenter />
          </DemoProvider>
        </SystemProvider>
      </body>
    </html>
  );
}
