/**
 * SeoHead.tsx — Per-route SEO meta tag component
 *
 * Usage:
 *   1. pnpm add react-helmet-async
 *   2. Wrap your app root with <HelmetProvider> in main.tsx or App.tsx
 *   3. Drop <SeoHead> at the top of each public page component
 *
 * Copy this file to: client/src/components/SeoHead.tsx
 */

import { Helmet } from "react-helmet-async";

interface SeoHeadProps {
  /** Page title — will be appended with " | AppName" */
  title: string;
  /** Meta description — 150-160 chars, Spanish, keyword-rich */
  description: string;
  /** Comma-separated keywords (optional, low SEO value but harmless) */
  keywords?: string;
  /** Canonical URL for this page — always use absolute URL */
  canonical?: string;
  /** Absolute URL to OG image (1200x630px, hosted on R2) */
  ogImage?: string;
  /** og:type — default "website" */
  ogType?: "website" | "article" | "product";
  /** Set true on /login, /register, /dashboard — prevents indexing */
  noIndex?: boolean;
  /** JSON-LD structured data object — pass output from structured-data.ts helpers */
  structuredData?: object | object[];
}

// ─── CONFIGURE THESE PER APP ─────────────────────────────────────────────────
const APP_NAME = "Plan Ninja";
const APP_URL = "https://plan-ninja.com";
const DEFAULT_OG_IMAGE = "https://r2.ninja-stack.com/plan-ninja/og-image.png";
const TWITTER_HANDLE = "@ninjastackHQ";
// ─────────────────────────────────────────────────────────────────────────────

export function SeoHead({
  title,
  description,
  keywords,
  canonical,
  ogImage = DEFAULT_OG_IMAGE,
  ogType = "website",
  noIndex = false,
  structuredData,
}: SeoHeadProps) {
  const fullTitle = `${title} | ${APP_NAME}`;
  const canonicalUrl = canonical ?? APP_URL;

  const ldJson = structuredData
    ? Array.isArray(structuredData)
      ? structuredData
      : [structuredData]
    : null;

  return (
    <Helmet>
      {/* ── Core ── */}
      <html lang="es" />
      <title>{fullTitle}</title>
      <meta name="description" content={description} />
      {keywords && <meta name="keywords" content={keywords} />}
      <link rel="canonical" href={canonicalUrl} />
      {noIndex && <meta name="robots" content="noindex, nofollow" />}

      {/* ── Open Graph ── */}
      <meta property="og:site_name" content={APP_NAME} />
      <meta property="og:title" content={fullTitle} />
      <meta property="og:description" content={description} />
      <meta property="og:type" content={ogType} />
      <meta property="og:url" content={canonicalUrl} />
      <meta property="og:image" content={ogImage} />
      <meta property="og:image:width" content="1200" />
      <meta property="og:image:height" content="630" />
      <meta property="og:locale" content="es_MX" />

      {/* ── Twitter Card ── */}
      <meta name="twitter:card" content="summary_large_image" />
      <meta name="twitter:site" content={TWITTER_HANDLE} />
      <meta name="twitter:title" content={fullTitle} />
      <meta name="twitter:description" content={description} />
      <meta name="twitter:image" content={ogImage} />

      {/* ── Structured Data ── */}
      {ldJson?.map((schema, i) => (
        <script key={i} type="application/ld+json">
          {JSON.stringify(schema)}
        </script>
      ))}
    </Helmet>
  );
}
