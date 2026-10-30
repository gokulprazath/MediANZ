import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { DevBanner } from "@/components/dev-banner";
import { SiteFooter } from "@/components/site-footer";
import { Providers } from "./providers";
import "./globals.css";

const geistSans = Geist({ variable: "--font-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: { default: "MediANZ", template: "%s · MediANZ" },
  description: "Book GP and clinic appointments, manage your health profile and review consultation transcripts.",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = { width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-AU" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="flex min-h-full flex-col">
        <Providers>
          <DevBanner />
          {children}
          <SiteFooter />
        </Providers>
      </body>
    </html>
  );
}
