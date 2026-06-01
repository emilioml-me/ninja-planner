/**
 * structured-data.ts — JSON-LD schema builders
 *
 * Usage: import the relevant builder in your page component and pass
 * the result to <SeoHead structuredData={...} />
 *
 * Copy this file to: client/src/lib/structured-data.ts
 */

// ─── Types ───────────────────────────────────────────────────────────────────

interface OrganizationOptions {
  name: string;
  url: string;
  logo: string;       // absolute URL to logo image
  description: string;
  sameAs?: string[];  // social profile URLs
}

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
  price?: string;      // "0" for free tier
  ratingValue?: number;
  ratingCount?: number;
  screenshot?: string; // absolute URL
}

interface WebSiteOptions {
  name: string;
  url: string;
  description: string;
  searchUrlTemplate?: string; // e.g. "https://example.com/buscar?q={search_term_string}"
}

interface FAQItem {
  question: string;
  answer: string;
}

interface BreadcrumbItem {
  name: string;
  url: string;
}

interface CourseOptions {
  name: string;
  description: string;
  provider: string;
  providerUrl: string;
  url: string;
  image?: string;
  price?: string;
  priceCurrency?: string;
}

interface JobPostingOptions {
  title: string;
  description: string;
  url: string;
  datePosted: string;       // ISO 8601
  validThrough?: string;    // ISO 8601
  employmentType?: string;  // "FULL_TIME" | "PART_TIME" | "CONTRACTOR"
  hiringOrganization: string;
  hiringOrganizationUrl: string;
  locationCity?: string;
  locationCountry?: string;
  remote?: boolean;
  salaryCurrency?: string;
  salaryMin?: number;
  salaryMax?: number;
}

// ─── Builders ────────────────────────────────────────────────────────────────

/**
 * Organization — use on brand hub / about page
 * ninja-stack.com should always include this
 */
export function buildOrganization(opts: OrganizationOptions) {
  return {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: opts.name,
    url: opts.url,
    logo: {
      "@type": "ImageObject",
      url: opts.logo,
    },
    description: opts.description,
    ...(opts.sameAs?.length ? { sameAs: opts.sameAs } : {}),
  };
}

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
    offers: {
      "@type": "Offer",
      price: opts.price ?? "0",
      priceCurrency: opts.priceCurrency ?? "MXN",
    },
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
 * WebSite — use on homepage, adds Sitelinks Searchbox to Google results
 */
export function buildWebSite(opts: WebSiteOptions) {
  return {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: opts.name,
    url: opts.url,
    description: opts.description,
    ...(opts.searchUrlTemplate
      ? {
          potentialAction: {
            "@type": "SearchAction",
            target: {
              "@type": "EntryPoint",
              urlTemplate: opts.searchUrlTemplate,
            },
            "query-input": "required name=search_term_string",
          },
        }
      : {}),
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

/**
 * BreadcrumbList — use on inner pages (course detail, blog post, etc.)
 * Triggers breadcrumb display in Google SERPs
 */
export function buildBreadcrumbs(items: BreadcrumbItem[]) {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: items.map((item, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name: item.name,
      item: item.url,
    })),
  };
}

/**
 * Course — use on ninja-learn course detail pages
 */
export function buildCourse(opts: CourseOptions) {
  return {
    "@context": "https://schema.org",
    "@type": "Course",
    name: opts.name,
    description: opts.description,
    provider: {
      "@type": "Organization",
      name: opts.provider,
      sameAs: opts.providerUrl,
    },
    url: opts.url,
    ...(opts.image ? { image: opts.image } : {}),
    ...(opts.price
      ? {
          offers: {
            "@type": "Offer",
            price: opts.price,
            priceCurrency: opts.priceCurrency ?? "MXN",
          },
        }
      : {}),
  };
}

/**
 * JobPosting — use on ninja-jobs individual job listing pages
 */
export function buildJobPosting(opts: JobPostingOptions) {
  return {
    "@context": "https://schema.org",
    "@type": "JobPosting",
    title: opts.title,
    description: opts.description,
    url: opts.url,
    datePosted: opts.datePosted,
    ...(opts.validThrough ? { validThrough: opts.validThrough } : {}),
    employmentType: opts.employmentType ?? "FULL_TIME",
    hiringOrganization: {
      "@type": "Organization",
      name: opts.hiringOrganization,
      sameAs: opts.hiringOrganizationUrl,
    },
    jobLocation: opts.remote
      ? { "@type": "Place", address: { "@type": "PostalAddress", addressCountry: "MX" } }
      : {
          "@type": "Place",
          address: {
            "@type": "PostalAddress",
            addressLocality: opts.locationCity ?? "Mexico",
            addressCountry: opts.locationCountry ?? "MX",
          },
        },
    ...(opts.remote ? { jobLocationType: "TELECOMMUTE" } : {}),
    ...(opts.salaryMin && opts.salaryMax
      ? {
          baseSalary: {
            "@type": "MonetaryAmount",
            currency: opts.salaryCurrency ?? "MXN",
            value: {
              "@type": "QuantitativeValue",
              minValue: opts.salaryMin,
              maxValue: opts.salaryMax,
              unitText: "MONTH",
            },
          },
        }
      : {}),
  };
}
