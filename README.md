# UPRN Lookup

Look up any UK UPRN and get its coordinates, straight from the OS Open UPRN
CSV. No server, no import step, no database.

## How it works

The published CSV is ~41.6 million rows and 2.1GB, and it is sorted ascending
by UPRN. That makes a lookup a plain binary search: ~31 reads of 256 bytes
each, via `Blob.slice()` against the file you pick. The file is never
uploaded, never copied, and never held in memory.

Average lookup: **0.61 ms**.

IndexedDB stores the `FileSystemFileHandle` so you only choose the file once.
It deliberately does *not* store the rows — importing all 41.6M records would
cost roughly 6GB of browser storage and 10–30 minutes of writes, to make an
exact-key lookup slower than it already is.

## Use it

You need your own copy of the data — at 2.1GB it is far past Cloudflare Pages'
25MB per-file limit, so it is not bundled.

1. Download **OS Open UPRN** (CSV) from
   [OS Data Hub](https://osdatahub.os.uk/downloads/open/OpenUPRN).
2. Open the app, click **Choose CSV…**, point it at `osopenuprn_*.csv`.
3. Type a UPRN.

## Run locally

```bash
python3 -m http.server 8777
```

Then open <http://localhost:8777>. Localhost is required rather than opening
the file directly: Chrome blocks both IndexedDB and `showOpenFilePicker` on
`file://` origins.

## Tests

Open `/?test=1` and choose the CSV. It asserts the first row, the last row, a
duplicate-coordinate pair, an interior gap, and values above and below the
range.

The same assertions run headlessly against the real file, using `sed` as
ground truth — 53 checks plus a 40-line random sweep, all exact.

## Scope

Lookup is UPRN → coordinates only, because that is all the file contains. Its
five columns are `UPRN, X_COORDINATE, Y_COORDINATE, LATITUDE, LONGITUDE` —
there are no addresses. Searching by postcode or address needs a second
dataset joined in: ONSUD (free, UPRN → postcode) or AddressBase (licensed,
full address strings). Radius search is possible but needs a real spatial
index rather than a binary search.

## Licence

Contains Ordnance Survey data © Crown copyright and database right 2026,
released under the [OS OpenData Licence](https://www.ordnancesurvey.co.uk/licensing/os-open-data-licence).
