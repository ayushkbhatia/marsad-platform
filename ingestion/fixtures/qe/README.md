# QE (Qatar Stock Exchange) — fixture provenance

Two generations of fixture live here. Read the table before trusting a file.

| File | Captured | Source | Status |
|---|---|---|---|
| `fs-*.json`, `filing-details-*.json` | 2026-07-17 | `qdisclosure/api/XBRL/*` | **Current.** Goldens for `adapters/qe/financials.ts`. |
| `marketwatch.txt` | 2026-07-13 | `/pps/qse_files/MarketWatch.txt` | **Retired URL.** See below. |
| `homepage.html` | 2026-07-13 | `https://www.qe.com.qa/` | Provenance only — the SPA shell the original route discovery came from. |

## ⚠ `marketwatch.txt` is a capture of a retired URL

`/pps/qse_files/MarketWatch.txt` turned out to be a **stale static file** (Last-Modified Oct 2025,
byte-identical intraday, QNBK frozen at 18.61). The live board is a POST to
`https://www.qe.com.qa/wp/mw_app/mw.php` with body `f=MarketWatch` — repointed by migration
`20260715085252_qe_quotes_live_board.sql`.

The response **schema is identical** (`{total, page, records, rows:[…]}`), so `quotes.ts` is
unaffected and its golden still tests the real parse path. But the fixture is ~132 KB / 107 rows
against a live board of ~461 KB / 126 rows, and it exercises no `-1.000` sentinel on any *mapped*
field (see the caveat in `quotes.ts`). Recapture when touching the quotes parser:

```sh
curl -sS -X POST 'https://www.qe.com.qa/wp/mw_app/mw.php' \
  -H 'content-type: application/x-www-form-urlencoded' \
  -H 'x-requested-with: XMLHttpRequest' \
  --data 'f=MarketWatch' -o marketwatch-live.json
```

The board is also the **QE universe of record**: 126 rows = 54 `CompType='COMP'` equities + 69
`BOND` + 2 `ETF` + 1 `V`. It carries `ISIN` (54/54 populated), `SectorEN`/`SectorCode`,
`CompMarketCap`, `FreeFloat`, `EPS`, `PERatio` — of which `quotes.ts` currently maps 16 of 46 fields.

## Financials fixtures (`fs-*.json`)

Captured verbatim from the API pinned on 2026-07-17, then **sorted** — see below.

| File | Why this one |
|---|---|
| `fs-QIBK-2024-12-31-Balancesheet.json` | Islamic bank (`qse-crc_`). The `EquityOfInvestmentAccountHolders` identity landmine: naive L+E leaves a **54%** gap and the gate rejects every filing. |
| `fs-AKHI-2024-12-31-Balancesheet.json` | Takaful insurer (`qse-ins-is_`). Emits **no `ifrs-full_Assets` at all**; totals come from the combined shareholders+policyholders tags. |
| `fs-QIBK-2024-12-31-Incomestatement.json` | Bank income statement — no `ifrs-full_Revenue`, exercises the `RevenueAndOperatingIncome` fallback. Annual span only (no standalone Q4). |
| `fs-QIBK-2024-06-30-Incomestatement.json` | Q2 — carries **both** the standalone quarter (`04-01→06-30`) and the cumulative YTD (`01-01→06-30`). The YTD-drop test. |
| `fs-QIBK-2024-12-31-Cashflow.json` | cfo/cfi/cff mapping. |
| `fs-IQCD-2024-12-31-Incomestatement.json` | Standard industrial (`ifrs-full_`) — real `Revenue` + `GrossProfit`, so the primary mapping must win over the fallback. |
| `filing-details-QIBK-2024-12-31.json` | `getFilingDetails=1` envelope → `filedAt`. |

### These fixtures are stored SORTED, deliberately

The API has **no `ORDER BY`** — the same URL returns the same facts in a different order on every
call (verified: 3/3 distinct raw sha256; 3/3 identical after sorting). An unsorted fixture would
produce a meaningless diff on every recapture. They are canonicalized on capture by sorting on
`(xbrlID, ToDate, FromDate, Value)` — the same ordering `canonicalizeQeFacts()` applies. Never
content-hash a raw QE body.

### Capture / recapture

Plain HTTP — no browser, no cookies, no referer, ~100 ms TTFB. (`robots.txt` disallows only
`/documents/`, `/guest/`, `*/c/portal/login`, `&p_p_id=20`; `/qdisclosure/api/` and `/pps/` are
allowed.)

```sh
API='https://www.qe.com.qa/qdisclosure/api/XBRL/GetFinancialStatementsAPIData'
canon() { python3 -c "
import sys,json
d=json.load(sys.stdin)
d.sort(key=lambda r:(r['xbrlID'], str(r.get('ToDate')), str(r.get('FromDate')), str(r.get('Value'))))
print(json.dumps(d, indent=2))
"; }

for sec in Balancesheet Incomestatement Cashflow; do
  curl -sS "$API?symCode=QIBK&reportEndDate=2024-12-31&sectionName=$sec&getFilingDetails=0" \
    | canon > "fs-QIBK-2024-12-31-$sec.json"
done
curl -sS "$API?symCode=QIBK&reportEndDate=2024-12-31&sectionName=&getFilingDetails=1" \
  > filing-details-QIBK-2024-12-31.json
```

`sectionName` ∈ `Balancesheet` | `Incomestatement` | `Cashflow`. The `sectionNames` variable in
`https://www.qe.com.qa/pps/XBRL/fsStatements.js` lists `financialPosition`/`statement`/`Cashflow` —
those are **DIV ids, not API values**, and return `[]`.

The PDFs are fetched from a sibling route and are **not** fixtured (they are ~1–2 MB binaries,
archived to Storage at runtime and never parsed):

```sh
# attachmentType: 1 = Detailed report (real issuer PDF) | 3 = "Detailed XBRL" (a RENDERED PDF,
# NOT an instance document — there is no raw XBRL to download). lang: 1=EN, 2=AR.
curl -sS 'https://www.qe.com.qa/qdisclosure/api/XBRL/CheckFSAttachmentExistAPI?symCode=QIBK&reportEndDate=2024-12-31&lang=1&attachmentType=1'  # -> 1 | 0
curl -sS 'https://www.qe.com.qa/qdisclosure/api/XBRL/GetFSAttachmentAPI?symCode=QIBK&reportEndDate=2024-12-31&lang=1&attachmentType=1' -o report.pdf
```

## Coverage facts worth knowing before you debug a "gap"

- **Depth floor is 2020.** 2016–2019 return `0` for every company sampled (QNBK QIBK DOHI IQCD ORDS
  MARK QEWS GWCS). Comparatives reach 2019. There is no pre-2020 history via this route.
- **Every response carries the prior-period comparative** — one call yields two periods.
- **Not every ticker has structured data.** At 2024-12-31: 51/54 do. `QATI` has a PDF but no JSON;
  `FALH`/`MFMS` listed in 2025. Zero rows there is correct, not a bug.
- **Identity verified across the whole universe** at 2024-12-31: 48 clean + 5 Islamic-bank
  (IAH-corrected) + 3 Takaful (split-fund corrected) = **0 failures**.
