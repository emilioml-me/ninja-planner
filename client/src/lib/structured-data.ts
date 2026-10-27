/**
 * structured-data.ts — JSON-LD schema builders
 *
 * Usage: import the relevant builder in your page component and pass
 * the result to <SeoHead structuredData={...} />
 * Only the builders the landing page uses are kept.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

interface SoftwareAppOptions {
  name: string;
  url: string;
  description: string;
  applicationCategory?:
    | "BusinessApplication"
    | "CommunicationApplication"
    | "EducationalApplication"
    | "FinanceApplication"
    | "ProductivityApplication"
    | "SocialNetworkingApplication"
    | "UtilitiesApplication";
  operatingSystem?: string;
  priceCurrency?: string;
  price?: string;      // omit when there's no public price: no Offer is emitted
  ratingValue?: number;
  ratingCount?: number;
  screenshot?: string; // absolute URL
}

interface FAQItem {
  question: string;
  answer: string;
}

// ─── Builders ────────────────────────────────────────────────────────────────

/**
 * SoftwareApplication — use on every SaaS product landing page
 */
export function buildSoftwareApp(opts: SoftwareAppOptions) {
  return {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: opts.name,
    url: opts.url,
    description: opts.description,
    applicationCategory: opts.applicationCategory ?? "BusinessApplication",
    operatingSystem: opts.operatingSystem ?? "Web",
    ...(opts.price !== undefined
      ? {
          offers: {
            "@type": "Offer",
            price: opts.price,
            priceCurrency: opts.priceCurrency ?? "MXN",
          },
        }
      : {}),
    ...(opts.ratingValue && opts.ratingCount
      ? {
          aggregateRating: {
            "@type": "AggregateRating",
            ratingValue: opts.ratingValue,
            ratingCount: opts.ratingCount,
          },
        }
      : {}),
    ...(opts.screenshot ? { screenshot: opts.screenshot } : {}),
  };
}

/**
 * FAQPage — use on landing page FAQ section
 * Triggers FAQ rich results (accordion) in Google SERPs
 */
export function buildFAQ(items: FAQItem[]) {
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: items.map((item) => ({
      "@type": "Question",
      name: item.question,
      acceptedAnswer: {
        "@type": "Answer",
        text: item.answer,
      },
    })),
  };
}
