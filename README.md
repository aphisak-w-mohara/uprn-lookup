# UPRN Lookup

Look up any UK UPRN and get its coordinates. No download, no database, no
server-side search.

**https://uprn-lookup.aphisak.workers.dev**

```bash
curl -s https://uprn-lookup.aphisak.workers.dev/api/uprn/200004746037
```

```json
{ "uprn": "200004746037", "lat": 50.8776793, "lng": -1.8704281 }
```

## The problem

OS Open UPRN is 41,676,575 rows and 2.1GB of CSV. That fits nowhere convenient:
GitHub blocks files over 100 MiB, Git LFS caps at 2 GiB (the file is 2.118),
GitHub Pages allows 1 GiB per site, and Cloudflare Pages allows 25 MiB per
file. Shipping the raw file to every visitor was the first design and it was
the wrong one — a 2.1GB download before the page does anything.

Two properties of the data make it unnecessary. It is sorted ascending by
UPRN, and each row is five numbers.

## Architecture

```
OS Data Hub  ──monthly──►  GitHub Actions  ──►  git (5,088 chunks)
                                │
                                └──►  Cloudflare Workers
                                        ├── static assets  ◄── browser fetches directly
                                        └── Worker         ◄── /api/* for other callers
```

Nothing queries a database. The browser fetches two static files from the CDN
and searches them itself; the Worker exists only so other callers get a JSON
API, and runs the identical search over the same assets, fronted by a rate
limit and a KV cache that the page never touches.

### Lookup: two binary searches, one round trip

`manifest.bin` holds the first UPRN of each chunk, so one binary search over it
identifies the single chunk that can contain a given UPRN. A second binary
search inside that chunk finds the record.

Worked example for `200004746037`:

| step | where | cost |
|---|---|---|
| binary search manifest, 5,088 entries | memory | 12 probes |
| fetch `d/5004.bin` | **network** | 55 KB, one round trip |
| binary search chunk, 8,192 records | memory | 13 probes |
| decode 16 bytes at offset 115,680 | memory | — |

25 comparisons, **one network request**, ~40 ms warm. The manifest is cached
after the first lookup, and chunks are served from the nearest Cloudflare edge
rather than a single region.

### Record and chunk layout

Each row becomes 16 bytes: the UPRN, then latitude and longitude as `int32`
scaled by 1e7. The source carries 7 decimal places, so the scaling is lossless
— and `int32` holds it, since `180 * 1e7` is inside `2^31`.

Chunks store three columns rather than interleaved rows, so each column wraps
in a typed array with no per-record parsing. With `n = payloadLength / 16`:

```
offset 0     uint64          first UPRN, absolute
offset 8     uint64 x (n-1)  gaps to the next UPRN
offset 8n    int32  x n      latitude,  scaled 1e7
offset 12n   int32  x n      longitude, scaled 1e7
```

`n` is derived from the payload length, so there is no header to pad around.

**Gaps are `uint64`, not `uint32`.** The largest gap in the 2026-09 release is
484,699,856,906 — 113x past `uint32` — and ten gaps exceed it. A narrower field
would silently corrupt those ten records while still passing a sampled check.
The wasted bytes are leading zeros, which is exactly what gzip removes, so the
safe field is effectively free. Varint encoding was measured at 0.3pp better
and gives up random access, so it was not worth it.

**UPRNs are read as `Float64`.** Exact to `2^53` against a largest UPRN of
~9.07e11, and it benchmarks at 22 ns per search versus 26 ns for
`BigUint64Array` and 33 ns for `DataView.getBigUint64` — with no BigInt in the
hot path.

**Payloads are gzipped on disk and inflated with `DecompressionStream`.** This
is not a preference. Cloudflare does not compress `application/octet-stream`,
and setting `Content-Encoding: gzip` by hand does not make browsers decode it
either — verified against the deployed site, which returns the header and the
raw gzip bytes. So compression has to be explicit at both ends.

Together, the columnar layout and delta encoding take the dataset from 2168 MiB
of CSV to **213 MiB on disk**, and a lookup from 128 KiB to about **43 KiB**.

### Why not the obvious alternatives

| | why not |
|---|---|
| Cloudflare D1 | Fits (798 MiB against a 10 GB cap) and was built, but `wrangler` pins a database to one region — ours landed in APAC, so every UK lookup would cross to Asia-Pacific. Refreshing also costs 41.6M row writes, roughly $33 a month. |
| One big file + HTTP Range | How PMTiles works, and it would mean 26 files instead of 5,088. Workers Static Assets **ignores `Range`** — verified: a range request returns HTTP 200 and the whole file. Also 25 MiB per file. Would require R2. |
| Data in Git LFS | Free quota is 10 GiB storage and bandwidth, so it fits. But LFS stores objects raw while git zlib-packs them, so a clone would be *larger* today. It only wins after about two monthly refreshes. |
| Ship the CSV to the browser | 2.1GB per visitor. |

## API

```
GET /api/uprn/{uprn}
```

```json
{ "uprn": "200004746037", "lat": 50.8776793, "lng": -1.8704281 }
```

404 if the UPRN is not in the dataset, 400 if it is not a safe integer, 405 for
non-GET, 429 if rate limited. CORS is open, so it is callable from anywhere.

The page does **not** use this endpoint — it fetches chunks directly from the
CDN, so a lookup costs no Worker invocation, and neither the rate limit nor the
cache below can affect the app itself.

### Rate limiting

120 requests per minute per IP, via the Workers rate limiting binding. Over the
limit returns 429 with `Retry-After: 60`.

It is per-Cloudflare-location and documented as permissive and eventually
consistent, so the cutoff is approximate — measured at 101 allowed and 39
rejected out of 140. That is the intended behaviour for abuse control rather
than accounting.

It **fails open**: if the limiter is unavailable the request is served and the
error logged. This is a public read-only lookup, so a limiter outage should not
take the API down with it.

Only `/api/*` is limited. Static assets, including the chunks the page reads,
are never touched — a client hammering the API cannot lock anyone out of the
site.

### KV cache

Successful lookups are cached in Workers KV, keyed `u:{dataset version}:{uprn}`.
Including the version means a monthly refresh invalidates every entry without
enumerating and deleting them. Entries also carry a 30-day TTL. Responses carry
`x-cache: HIT` or `MISS`.

Measured on the deployed Worker, averaged over six samples each:

| | |
|---|---|
| `x-cache: HIT` | **111 ms** |
| `x-cache: MISS` (full chunk path) | **391 ms** |

The saving is real because isolates rotate: a miss often has to re-fetch and
re-inflate a 43 KB chunk, which a hit skips entirely. A warm isolate that
already holds the chunk can beat KV, but that is not the common case.

Writes are wrapped in `waitUntil`, so caching never delays a response, and both
reads and writes are non-fatal — a KV outage just means doing the lookup.

**Only hits are cached.** Misses are cheap once a chunk is warm, and caching
them would let a client enumerating nonexistent UPRNs burn the KV write quota
(1M writes/month on Workers Paid).

## Layout

```
public/
  index.html        the app; also the API-free local CSV mode
  manifest.bin      gzipped Float64Array of each chunk's first UPRN
  version.json      dataset provenance, rewritten by CI
  _headers          cache policy for chunks
  d/0000.bin ...    5,088 gzipped columnar chunks
src/worker.js       /api/* — same search, over the asset binding
tools/build-chunks.py   CSV -> chunks + manifest
```

## Automation

Two workflows, both pinning `actions/checkout` by commit SHA and `wrangler` by
version, because both hold a deploy token.

**`refresh-data.yml`** — monthly, on the 8th, plus manual with a `force` input.
It compares the md5 published by the OS API against `version.json` **before
downloading anything**. Every release replaces all 5,088 chunks, so a rebuild
producing identical bytes would still cost ~213 MiB of history; the gate makes
an unchanged month exit in about 30 seconds. When the dataset has moved it
verifies the download against the published md5 before unzipping, rebuilds,
samples 40 rows uniformly from the source CSV and looks each one up through the
generated chunks, and only then commits and deploys.

**`deploy.yml`** — on pushes to `main` touching `public/`, `src/` or
`wrangler.jsonc`. After deploying it smoke-tests the live URL against known
coordinates for a first, last and missing UPRN. A deploy that returns 200 while
serving wrong bytes is the failure worth catching, and a status check would not
catch it.

The refresh workflow deploys from its own job rather than relying on
`deploy.yml`: pushes made with `GITHUB_TOKEN` do not trigger workflows, so its
commit would never reach it. That is also why there is no loop.

Requires two repository secrets: `CLOUDFLARE_API_TOKEN` (Workers → Editor) and
`CLOUDFLARE_ACCOUNT_ID`.

### Reproducibility

Builds are byte-identical across platforms, which is what lets an unchanged
dataset commit nothing. That needed one fix: CPython writes the gzip header's
OS byte from the build platform — 3 on Linux, 255 on macOS — so a local rebuild
and a CI rebuild differed in exactly one byte per file, and git saw all 5,088
as changed. The generator pins that byte.

### Repository size

Each release replaces every chunk and git history is append-only, so a refresh
costs ~213 MiB that never goes away — against GitHub's 5 GB soft limit.

If that becomes a problem, delete the `Commit` step from `refresh-data.yml` and
gitignore `public/d/` and `public/manifest.bin`. The data is fully reproducible
from the OS download, `wrangler deploy` uploads from the working tree, and the
repository stops growing. The only thing lost is having past releases' exact
bytes in git.

## Rebuilding by hand

Download **OS Open UPRN** (CSV) from
[OS Data Hub](https://osdatahub.os.uk/downloads/open/OpenUPRN), then:

```bash
python3 tools/build-chunks.py path/to/osopenuprn_*.csv public
wrangler deploy
```

The generator asserts the input is strictly ascending and exits if it is not —
the binary search depends on that property, so it is checked rather than
assumed.

## Tests

Open `/?test=1`. It asserts the first row, the last row, a duplicate-coordinate
pair, an interior gap, and values above and below the range, against whichever
source is active.

Headless verification extracts the page's own search function and runs it
against the generated chunks with `sed` as ground truth, covering chunk
boundaries, the 484-billion gap in chunk 5026, and a random sweep. CI runs a
40-row uniform sample on every rebuild.

## Local CSV mode

The page also reads the raw OS CSV straight off your disk, by binary search
over `Blob.slice()` — nothing is uploaded, nothing is imported. It is behind a
disclosure on the page. Useful offline, and it reads the source data directly,
which makes it the way to check the hosted index against ground truth.

## Scope

Lookup is UPRN → coordinates, because that is all the source contains. Its five
columns are `UPRN, X_COORDINATE, Y_COORDINATE, LATITUDE, LONGITUDE` — there are
no addresses. Searching by postcode or address needs a second dataset: ONSUD
(free, UPRN → postcode) or AddressBase (licensed, full addresses).

Easting and northing are not served. They are OSTN15 values in the source, and
re-deriving them from lat/lng lands about a metre off. Restoring them means
widening the record and regenerating.

## Licence

Contains Ordnance Survey data © Crown copyright and database right 2026,
released under the [OS OpenData Licence](https://www.ordnancesurvey.co.uk/licensing/os-open-data-licence).
