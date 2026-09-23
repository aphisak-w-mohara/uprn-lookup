// Lookup strategy: the dataset is sorted ascending by UPRN and split into
// fixed-width binary chunks. manifest.bin holds the first UPRN of each chunk,
// so a binary search over it identifies the single chunk that can contain a
// given UPRN - one asset read, no scanning.
//
// Records are 16 bytes: uint64 UPRN, int32 lat, int32 lng (both scaled 1e7).
const REC = 16;
const SCALE = 1e7;

// Cached per isolate. The manifest is 40 KiB and immutable for a deployment.
let manifest = null;

async function asset(env, request, path) {
  const res = await env.ASSETS.fetch(new URL(path, request.url));
  if (!res.ok) throw new Error(`asset ${path} -> ${res.status}`);
  return res.arrayBuffer();
}

async function getManifest(env, request) {
  if (!manifest) manifest = new BigUint64Array(await asset(env, request, "/manifest.bin"));
  return manifest;
}

// Index of the last chunk whose first UPRN is <= target, or -1 if target
// sorts before the whole dataset.
function chunkFor(man, target) {
  let lo = 0, hi = man.length - 1, found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (man[mid] <= target) { found = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return found;
}

function searchChunk(buf, target) {
  const dv = new DataView(buf);
  let lo = 0, hi = buf.byteLength / REC - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const u = dv.getBigUint64(mid * REC, true);
    if (u === target) {
      return {
        uprn: String(u),
        lat: dv.getInt32(mid * REC + 8, true) / SCALE,
        lng: dv.getInt32(mid * REC + 12, true) / SCALE,
      };
    }
    if (u < target) lo = mid + 1; else hi = mid - 1;
  }
  return null;
}

const json = (body, status = 200) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "cache-control": status === 200 ? "public, max-age=86400" : "no-store",
    },
  });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
    if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);

    const m = url.pathname.match(/^\/api\/uprn\/([0-9]{1,12})\/?$/);
    if (!m) return json({ error: "Not found", usage: "GET /api/uprn/{uprn}" }, 404);

    const target = BigInt(m[1]);
    try {
      const man = await getManifest(env, request);
      const idx = chunkFor(man, target);
      if (idx < 0) return json({ error: "Not found", uprn: m[1] }, 404);
      const buf = await asset(env, request, `/d/${String(idx).padStart(4, "0")}.bin`);
      const row = searchChunk(buf, target);
      return row ? json(row) : json({ error: "Not found", uprn: m[1] }, 404);
    } catch (err) {
      console.error("lookup failed", err.stack || String(err));
      return json({ error: "Lookup failed" }, 500);
    }
  },
};
