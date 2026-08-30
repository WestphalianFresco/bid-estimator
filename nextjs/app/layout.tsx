import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import "./globals.css";

/**
 * The typeface.
 *
 * Apple's own pages run on SF Pro, which is not licensed for redistribution and
 * ships only with their operating systems. So the stack asks for it first —
 * a Mac or an iPhone renders the real thing through `-apple-system` — and falls
 * back to Inter everywhere else, which was drawn to the same brief and is close
 * enough that the two are hard to tell apart at UI sizes.
 *
 * `next/font` self-hosts Inter rather than linking Google's CDN: no third-party
 * request at runtime, no layout shift while a webfont arrives.
 */
const inter = Inter({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-inter",
});

export const metadata: Metadata = {
  title: "Mayorga Estimate Studio — We Estimate Better",
  description:
    "Conceptual construction cost estimating. AACE Class 4–5 (±20–30%), priced from prevailing " +
    "wage rates and a calibrated rate catalog, then cross-checked against comparable projects.",
};

export const viewport: Viewport = {
  themeColor: "#f5f5f7",
};

/*
 * One surface, and it is the paper one.
 *
 * The screen shows the document on the ground it will be printed on, so there
 * is nothing to reconcile between what an estimator reads and what a client
 * receives. The dark palette is still defined and still validated; it is
 * reached by setting data-theme="dark" here, and by nothing in the UI.
 */

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={inter.variable}>
      <body>{children}</body>
    </html>
  );
}
