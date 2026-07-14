# Argaam financials fixtures (real captured bytes)

Golden material for the PDF-first financials pipeline (docs/plans/p17-financials-pdf-architecture.md).

- `sabic-en-2026Q1.pdf` — SABIC (TASI 2010) Q1-2026 condensed consolidated interim statements, EN,
  captured 2026-07-14 from `argaamplus.s3.amazonaws.com/91ffd49e-e704-4f03-a1e4-e2862600626e.pdf`
  (open S3 object; enumerated via the headless Argaam `/en/company/financial-pdf/3/2025` index).
  Born-digital (MS Word producer), 22 pages, 1.05 MB.
- `sabic-en-2026Q1.pdftotext.txt` — `pdftotext -layout` output (the EXTRACTION-service input fixture).

Ground-truth sanity (the validation gate must confirm these; thousands SAR):
  Total assets 237,906,104 == Total equity 149,079,712 + Total liabilities 88,826,392  (balance-sheet identity)
  Revenue 26,151,935 · Gross profit 5,128,239 · Net income 284,091 · EPS 0.27 · Cash & equivalents 24,553,896
Discovery path metadata comes free from the EN link:
  argaam.com/en/Tadawul/{MARKET}/{ticker}/financial-report/{year}/{period}/{uuid}.pdf
