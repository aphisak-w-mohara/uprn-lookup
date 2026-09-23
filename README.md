# UPRN Lookup

Look up any UK UPRN and get its coordinates. No download, no database, no
server-side search.

**https://uprn-lookup.aphisak.workers.dev**

## How it works

The OS Open UPRN release is 41,676,575 rows and 2.1GB of CSV, sorted ascending
by UPRN. Two things follow from that.

First, the CSV is wasteful. Each row becomes a fixed 16-byte record — `uint64`
UPRN, then latitude and longitude as `int32` scaled by 1e7. The source has 7
decimal places, so the scaled integers are lossless, and the whole dataset
drops from 2168 MiB to **636 MiB**. Fixed width also means record *i* sits at
exactly `i*16`, so searching within a chunk is index arithmetic rather than
line parsing.

Second, because it is sorted, you never need to look at most of it. The data is
cut into 5,088 chunks of 8192 records (128 KiB each), and `manifest.bin` holds
the first UPRN of every chunk — 40 KiB total. A binary search over the manifest
identifies the one chunk that can contain a given UPRN.

So a lookup is: binary search 40 KiB in memory, fetch one 128 KiB chunk
(~52 KiB gzipped over the wire), binary search 8192 records inside it.

**One network round trip.** The manifest is cached after the first lookup, and
chunks are served from the Cloudflare edge rather than a single region.

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
