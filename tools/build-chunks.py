#!/usr/bin/env python3
"""Turn the OS Open UPRN CSV into fixed-width binary chunks + a manifest.

The CSV is sorted ascending by UPRN, so a manifest holding the first UPRN of
each chunk is enough to find the one chunk that can contain any given UPRN.
That makes a lookup a single fetch.

Records are 16 bytes: uint64 UPRN, then latitude and longitude as int32
scaled by 1e7. The source has 7 decimal places, so the scaled integers are
lossless, and fixed width means record i sits at exactly i*16 - the in-chunk
search is index arithmetic rather than line parsing.

    python3 tools/build-chunks.py <osopenuprn_*.csv> [outdir]
"""
import os
import struct
import sys

RECORDS_PER_CHUNK = 8192          # 8192 * 16 B = 128 KiB exactly
SCALE = 10_000_000                # 7 decimal places, matching the source
REC = struct.Struct("<Qii")

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

    firsts: list[int] = []
    buf = bytearray()
    n = chunks = 0
    prev = -1

    def flush() -> None:
        nonlocal buf, chunks
        if not buf:
            return
        with open(os.path.join(ddir, f"{chunks:04d}.bin"), "wb") as fh:
            fh.write(buf)
        chunks += 1
        buf = bytearray()

    with open(src, encoding="utf-8-sig") as fh:
        header = next(fh).strip().split(",")
        if header[:1] != ["UPRN"] or len(header) < 5:
            sys.exit(f"unexpected header: {header}")
        for line in fh:
            parts = line.rstrip("\r\n").split(",")
            uprn = int(parts[0])
            # The binary search depends on this, so assert it rather than trust it.
            if uprn <= prev:
                sys.exit(f"not sorted ascending at row {n + 1}: {uprn} after {prev}")
            prev = uprn
            if not buf:
                firsts.append(uprn)
            # round, not truncate: 51.4526038 * 1e7 can land a hair under.
            buf += REC.pack(uprn, round(float(parts[3]) * SCALE),
                            round(float(parts[4]) * SCALE))
            n += 1
            if len(buf) >= RECORDS_PER_CHUNK * REC.size:
                flush()
    flush()

    with open(os.path.join(out, "manifest.bin"), "wb") as fh:
        fh.write(struct.pack(f"<{len(firsts)}Q", *firsts))

    print(f"{n:,} rows -> {chunks:,} chunks, manifest {len(firsts) * 8:,} bytes")
    print(f"chunk dir {ddir} = {sum(os.path.getsize(os.path.join(ddir, f)) for f in os.listdir(ddir)) / 1048576:.0f} MiB")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
