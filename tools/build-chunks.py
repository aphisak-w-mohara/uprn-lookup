#!/usr/bin/env python3
"""Turn the OS Open UPRN CSV into gzipped columnar chunks + a manifest.

The CSV is sorted ascending by UPRN, so a manifest holding the first UPRN of
each chunk is enough to find the one chunk that can contain any given UPRN.
A lookup is therefore a single fetch.

Each chunk holds RECORDS_PER_CHUNK records as three columns rather than
interleaved rows, which lets the reader wrap each column in a typed array
with no per-record parsing:

    offset 0      uint64            first UPRN, absolute
    offset 8      uint64 x (n-1)    gaps to the next UPRN
    offset 8n     int32  x n        latitude,  scaled by 1e7
    offset 12n    int32  x n        longitude, scaled by 1e7

n is derived from the payload length (16 bytes per record), so there is no
header to pad around.

Gaps are uint64 rather than uint32: the largest gap in the 2026-09 release is
484,699,856,906, which is 113x past uint32, and ten gaps exceed it. The extra
bytes are almost all leading zeros, which is exactly what gzip removes - the
encoding measures ~38% of the row-interleaved original once compressed, so
narrowing the field would buy nothing and silently corrupt those records.

Payloads are gzipped on disk and decompressed by the client with
DecompressionStream. Cloudflare does not compress application/octet-stream,
and setting Content-Encoding by hand does not make browsers decode it, so
compression has to be explicit on both ends.

    python3 tools/build-chunks.py <osopenuprn_*.csv> [outdir]
"""
import gzip
import os
import struct
import sys

RECORDS_PER_CHUNK = 8192
SCALE = 10_000_000
GZIP_LEVEL = 9


def pack_chunk(uprns, lats, lngs):
    n = len(uprns)
    gaps = [uprns[i] - uprns[i - 1] for i in range(1, n)]
    return (
        struct.pack("<Q", uprns[0])
        + struct.pack(f"<{n - 1}Q", *gaps)
        + struct.pack(f"<{n}i", *lats)
        + struct.pack(f"<{n}i", *lngs)
    )


def main() -> int:
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    src = sys.argv[1]
    out = sys.argv[2] if len(sys.argv) > 2 else "public"
    ddir = os.path.join(out, "d")
    os.makedirs(ddir, exist_ok=True)
    for stale in os.listdir(ddir):
        if stale.endswith(".bin"):
            os.remove(os.path.join(ddir, stale))

    firsts, u, la, ln = [], [], [], []
    n = chunks = 0
    prev = -1
    raw_total = gz_total = 0

    def flush():
        nonlocal chunks, u, la, ln, raw_total, gz_total
        if not u:
            return
        payload = pack_chunk(u, la, ln)
        blob = gzip.compress(payload, GZIP_LEVEL, mtime=0)
        with open(os.path.join(ddir, f"{chunks:04d}.bin"), "wb") as fh:
            fh.write(blob)
        raw_total += len(payload)
        gz_total += len(blob)
        chunks += 1
        u, la, ln = [], [], []

    with open(src, encoding="utf-8-sig") as fh:
        header = next(fh).strip().split(",")
        if header[:1] != ["UPRN"] or len(header) < 5:
            sys.exit(f"unexpected header: {header}")
        for line in fh:
            p = line.rstrip("\r\n").split(",")
            uprn = int(p[0])
            # The binary search depends on this, so assert it rather than trust it.
            if uprn <= prev:
                sys.exit(f"not sorted ascending at row {n + 1}: {uprn} after {prev}")
            prev = uprn
            if not u:
                firsts.append(uprn)
            u.append(uprn)
            # round, not truncate: 51.4526038 * 1e7 can land a hair under.
            la.append(round(float(p[3]) * SCALE))
            ln.append(round(float(p[4]) * SCALE))
            n += 1
            if len(u) == RECORDS_PER_CHUNK:
                flush()
    flush()

    # Float64 is exact to 2^53 and the largest UPRN is ~9.07e11, so the reader
    # can search this as a Float64Array without BigInt.
    man = gzip.compress(struct.pack(f"<{len(firsts)}d", *firsts), GZIP_LEVEL, mtime=0)
    with open(os.path.join(out, "manifest.bin"), "wb") as fh:
        fh.write(man)

    print(f"{n:,} rows -> {chunks:,} chunks, manifest {len(man):,} bytes gzipped")
    print(f"payload {raw_total / 1048576:.0f} MiB -> on disk {gz_total / 1048576:.0f} MiB "
          f"({100 * gz_total / raw_total:.1f}%), mean chunk {gz_total // max(chunks, 1):,} bytes")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
