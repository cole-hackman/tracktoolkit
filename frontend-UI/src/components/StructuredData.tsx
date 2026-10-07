// JSON-LD Structured Data for SEO
// This component injects schema.org structured data into the page

export interface FAQ {
  question: string;
  answer: string;
}

interface StructuredDataProps {
  faqs?: FAQ[];
}

export function StructuredData({ faqs = [] }: StructuredDataProps) {
  const organizationSchema = {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: "Track Toolkit",
    // Keeps the rebrand legible to search engines: the site has years of
    // links and queries pointing at the old names.
    alternateName: ["SoundCloud Toolkit", "SC Toolkit"],
    url: "https://tracktoolkit.com",
    logo: "https://tracktoolkit.com/brand/icon-512.png",
    description:
      "Track Toolkit helps SoundCloud power users organize, merge, and clean playlists.",
  };

  const softwareApplicationSchema = {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: "Track Toolkit",
    alternateName: ["SoundCloud Toolkit", "SC Toolkit"],
    applicationCategory: "MusicApplication",
    operatingSystem: "Web",
    description:
      "Powerful playlist management tools for SoundCloud. Merge playlists, remove duplicates, organize tracks, and more.",
    url: "https://tracktoolkit.com",
    offers: {
      "@type": "Offer",
      price: "0",
      priceCurrency: "USD",
    },
  };

  const faqSchema =
    faqs.length > 0
      ? {
          "@context": "https://schema.org",
          "@type": "FAQPage",
          mainEntity: faqs.map((faq) => ({
            "@type": "Question",
            name: faq.question,
            acceptedAnswer: {
              "@type": "Answer",
              text: faq.answer,
            },
          })),
        }
      : null;

  const webSiteSchema = {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: "Track Toolkit",
    alternateName: ["SoundCloud Toolkit", "SC Toolkit"],
    url: "https://tracktoolkit.com",
    description:
      "Track Toolkit helps SoundCloud power users organize, merge, and clean playlists. Remove duplicates, manage tracks, and build better playlists faster.",
    // No SearchAction: the site has no search, and Google crawled the
    // literal `/?q={search_term_string}` template as a page.
  };

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(organizationSchema),
        }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(softwareApplicationSchema),
        }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(webSiteSchema),
        }}
      />
      {faqSchema && (
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify(faqSchema),
          }}
        />
      )}
    </>
  );
}

export default StructuredData;

