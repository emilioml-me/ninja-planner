/**
 * SeoHead.tsx — Per-route SEO meta tag component
 *
 * Uses useEffect + direct DOM manipulation so no external package is required.
 * Drop <SeoHead> at the top of each public page component.
 */

import { useEffect } from "react";

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

function setMeta(selector: string, content: string) {
  let el = document.querySelector<HTMLMetaElement>(selector);
  if (!el) {
    el = document.createElement("meta");
    const attrMatch = selector.match(/\[(\w+(?::\w+)?)="([^"]+)"\]/);
    if (attrMatch) {
      el.setAttribute(attrMatch[1], attrMatch[2]);
    }
    document.head.appendChild(el);
  }
  el.setAttribute("content", content);
}

function setLink(rel: string, href: string) {
  let el = document.querySelector<HTMLLinkElement>(`link[rel="${rel}"]`);
  if (!el) {
    el = document.createElement("link");
    el.setAttribute("rel", rel);
    document.head.appendChild(el);
  }
  el.setAttribute("href", href);
}

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

  useEffect(() => {
    // ── Core ──
    document.title = fullTitle;
    document.documentElement.setAttribute("lang", "es");
    setMeta('meta[name="description"]', description);
    setLink("canonical", canonicalUrl);

    if (keywords) {
      setMeta('meta[name="keywords"]', keywords);
    }

    const robotsSelector = 'meta[name="robots"]';
    if (noIndex) {
      setMeta(robotsSelector, "noindex, nofollow");
    } else {
      const el = document.querySelector<HTMLMetaElement>(robotsSelector);
      if (el) el.remove();
    }

    // ── Open Graph ──
    setMeta('meta[property="og:site_name"]', APP_NAME);
    setMeta('meta[property="og:title"]', fullTitle);
    setMeta('meta[property="og:description"]', description);
    setMeta('meta[property="og:type"]', ogType);
    setMeta('meta[property="og:url"]', canonicalUrl);
    setMeta('meta[property="og:image"]', ogImage);
    setMeta('meta[property="og:image:width"]', "1200");
    setMeta('meta[property="og:image:height"]', "630");
    setMeta('meta[property="og:locale"]', "es_MX");

    // ── Twitter Card ──
    setMeta('meta[name="twitter:card"]', "summary_large_image");
    setMeta('meta[name="twitter:site"]', TWITTER_HANDLE);
    setMeta('meta[name="twitter:title"]', fullTitle);
    setMeta('meta[name="twitter:description"]', description);
    setMeta('meta[name="twitter:image"]', ogImage);

    // ── Structured Data ──
    const existingScripts = document.querySelectorAll(
      'script[type="application/ld+json"][data-seohead]'
    );
    existingScripts.forEach((s) => s.remove());

    if (structuredData) {
      const schemas = Array.isArray(structuredData)
        ? structuredData
        : [structuredData];
      schemas.forEach((schema) => {
        const script = document.createElement("script");
        script.type = "application/ld+json";
        script.setAttribute("data-seohead", "true");
        script.textContent = JSON.stringify(schema);
        document.head.appendChild(script);
      });
    }
  }, [fullTitle, description, keywords, canonicalUrl, ogImage, ogType, noIndex, structuredData]);

  return null;
}
