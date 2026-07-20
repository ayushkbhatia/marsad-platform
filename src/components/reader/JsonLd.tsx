/**
 * Server-rendered JSON-LD structured-data block. Emits a single
 * `<script type="application/ld+json">` with the given schema.org object.
 *
 * Only public, non-premium fields are ever passed in by callers (identity,
 * filing metadata) — never financials, ratios, or factor grades. The payload is
 * serialized with a `<` escape so a stray sequence in a company/filing title
 * can't break out of the script element.
 */
export function JsonLd({ data }: { data: Record<string, unknown> }) {
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{
        __html: JSON.stringify(data).replace(/</g, "\\u003c"),
      }}
    />
  );
}
