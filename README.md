# UPRN Lookup

Look up any UK UPRN and get its coordinates. No download, no database, no
server-side search.

**https://uprn-lookup.aphisak.workers.dev**

## How it works

The OS Open UPRN release is 41,676,575 rows and 2.1GB of CSV, sorted ascending
by UPRN. Two things follow from that.

First, the CSV is wasteful. Each row becomes 16 bytes — the UPRN, then latitude
and longitude as `int32` scaled by 1e7. The source has 7 decimal places, so the
scaled integers are lossless.

Second, because it is sorted, you never need to look at most of it. The data is
cut into 5,088 chunks of 8192 records, and `manifest.bin` holds the first UPRN
of every chunk. A binary search over the manifest identifies the one chunk that
can contain a given UPRN.

So a lookup is: binary search the manifest in memory, fetch one chunk, binary
search 8192 records inside it. **One network round trip**, around 40 ms warm,
served from the Cloudflare edge rather than a single region.

### Chunk layout

Chunks store three columns rather than interleaved rows, so each column wraps
in a typed array with no per-record parsing. With `n = payloadLength / 16`:

```
offset 0     uint64          first UPRN, absolute
offset 8     uint64 x (n-1)  gaps to the next UPRN
offset 8n    int32  x n      latitude,  scaled 1e7
offset 12n   int32  x n      longitude, scaled 1e7
```

Gaps are `uint64`, not `uint32`. The largest gap in the 2026-09 release is
484,699,856,906 — 113x past `uint32` — and ten gaps exceed it, so a narrower
field would silently corrupt those records. The extra bytes are almost all
leading zeros, which is exactly what gzip removes, so it costs nothing.

UPRNs are read as `Float64`: exact to 2^53, the largest is ~9.07e11, and it
benchmarks faster than `BigUint64Array` (22 ns vs 26 ns per search) while
keeping BigInt out of the hot path entirely.

Payloads are gzipped on disk and inflated by the client with
`DecompressionStream`. That is not a preference — Cloudflare does not compress
`application/octet-stream`, and setting `Content-Encoding: gzip` by hand does
not make browsers decode it either, so compression has to be explicit on both
ends. Together the columnar layout and delta encoding take the dataset from
636 MiB to **213 MiB**, and a lookup from 128 KiB to about **43 KiB**.

## API

```
GET /api/uprn/906700601612
```

```json
{
  "uprn": "906700601612",
  "lat": 55.8823426,
  "lng": -4.2786558
}
```

404 if the UPRN is not in the dataset, 400 if it is longer than 12 digits.
CORS is open, so it is callable from anywhere.

The Worker runs the same search as the browser, reading chunks through its
static-asset binding. The page itself does not use the API — it fetches chunks
directly from the CDN, so a lookup costs no Worker invocation.

## Rebuilding the data

Chunks are committed, but they are reproducible. Download **OS Open UPRN**
(CSV) from [OS Data Hub](https://osdatahub.os.uk/downloads/open/OpenUPRN), then:

```bash
python3 tools/build-chunks.py path/to/osopenuprn_*.csv public
```

The generator asserts the input is strictly ascending and exits if it is not —
the binary search depends on that property, so it is checked rather than
assumed.

## Refreshing the data

OS publishes OS Open UPRN monthly. `.github/workflows/refresh-data.yml` runs on
the 8th of each month, and can be triggered by hand with a `force` option.

It checks the published md5 against `public/version.json` **before downloading
anything**. An unchanged dataset means the job exits in a few seconds without
committing — otherwise every month would add another identical ~254 MiB to git
history.

When the dataset has changed it downloads the zip, verifies the md5, rebuilds
the chunks, samples 40 rows uniformly from the source CSV and looks each one up
through the generated chunks, and only then commits and deploys.

Requires two repository secrets: `CLOUDFLARE_API_TOKEN` (needs Workers Scripts
edit) and `CLOUDFLARE_ACCOUNT_ID`.

### A note on repository size

Each refresh replaces every chunk, because UPRNs shift, and git history is
append-only. That is roughly 254 MiB per release that never goes away — about
3 GiB a year, against GitHub's 5 GB soft limit.

If that becomes a problem, delete the `Commit` step from the workflow and
gitignore `public/d/` and `public/manifest.bin`. The data is fully reproducible
from the OS download, `wrangler deploy` uploads from the working tree, and the
repository stops growing. The only thing lost is having the exact bytes of past
releases in git.

## Deploying

```bash
wrangler deploy
```

Uploads from the working tree, so Cloudflare never clones the repo.

## Tests

Open `/?test=1`. It asserts the first row, the last row, a
duplicate-coordinate pair, chunk-boundary UPRNs, an interior gap, and values
above and below the range.

The same assertions run headlessly against the generated chunks with `sed` as
ground truth — 76 checks including a 60-line random sweep, all exact, and it
confirms the one-fetch-per-lookup property.

## Local CSV mode

The page also reads the raw OS CSV straight off your disk, by binary search
over `Blob.slice()` — nothing is uploaded, nothing is imported. It is behind a
disclosure on the page. Useful offline, and it reads the source data directly,
which makes it the way to check the hosted index against ground truth.

## Scope

Lookup is UPRN → coordinates, because that is all the source contains. Its five
columns are `UPRN, X_COORDINATE, Y_COORDINATE, LATITUDE, LONGITUDE` — no
addresses. Searching by postcode or address needs a second dataset: ONSUD
(free, UPRN → postcode) or AddressBase (licensed, full addresses).

Easting and northing are not served. They are OSTN15 values in the source, and
re-deriving them from lat/lng client-side lands about a metre off. Restoring
them means widening the record to 24 bytes and regenerating.

## Licence

Contains Ordnance Survey data © Crown copyright and database right 2026,
released under the [OS OpenData Licence](https://www.ordnancesurvey.co.uk/licensing/os-open-data-licence).
