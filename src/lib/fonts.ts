/*
 * Marsad font trio (design-tokens.json §typography).
 *
 * ORCHESTRATOR WIRING — this module must not touch layout.tsx itself.
 * In src/app/layout.tsx:
 *
 *   import { newsreader, libreFranklin, plexMono } from "@/lib/fonts";
 *
 *   <html
 *     lang="en"
 *     className={`${newsreader.variable} ${libreFranklin.variable} ${plexMono.variable} h-full antialiased`}
 *   >
 *
 * (Replace the Geist/Geist_Mono imports and their variable classes; the
 * @theme block in globals.css references --font-newsreader,
 * --font-libre-franklin and --font-plex-mono.)
 */
import { IBM_Plex_Mono, Libre_Franklin, Newsreader } from "next/font/google";

/** Display serif — headlines, hero numerals (Score), pull-quotes.
 *  Variable weight with the optical-sizing axis on, per token spec. */
export const newsreader = Newsreader({
  subsets: ["latin"],
  weight: "variable",
  style: ["normal", "italic"],
  axes: ["opsz"],
  variable: "--font-newsreader",
  display: "swap",
});

/** UI sans — body copy, labels, buttons, form fields. */
export const libreFranklin = Libre_Franklin({
  subsets: ["latin"],
  weight: "variable",
  variable: "--font-libre-franklin",
  display: "swap",
});

/** Mono — tickers, prices, timestamps, eyebrow labels, data tables.
 *  IBM Plex Mono is not a variable font; load the three weights used. */
export const plexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-plex-mono",
  display: "swap",
});
