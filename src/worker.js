// Lookup strategy: the dataset is sorted by UPRN and split into gzipped
// columnar chunks. manifest.bin holds the first UPRN of each chunk, so a
// binary search over it identifies the single chunk that can contain a given
// UPRN - one asset read, no scanning.
//
// Chunk payload, n = byteLength / 16:
//   0     uint64          first UPRN, absolute
//   8     uint64 x (n-1)  gaps
//   8n    int32  x n      lat, scaled 1e7
//   12n   int32  x n      lng, scaled 1e7
//
// Cloudflare does not compress application/octet-stream and setting
// Content-Encoding by hand does not make clients decode it, so the payloads
// are gzipped on disk and inflated here explicitly.
const SCALE = 1e7;

// Cached per isolate; both are immutable for a deployment.
let manifest = null;
const chunks = new Map();

async function gunzip(buf) {
  const stream = new Response(buf).body.pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).arrayBuffer();
}

async function asset(env, request, path) {
  const res = await env.ASSETS.fetch(new URL(path, request.url));
  if (!res.ok) throw new Error(`asset ${path} -> ${res.status}`);
  return gunzip(await res.arrayBuffer());
}

// Float64 is exact to 2^53 and the largest UPRN is ~9.07e11, so the whole
// search runs on plain numbers - no BigInt in the hot path.
async function getManifest(env, request) {
  if (!manifest) manifest = new Float64Array(await asset(env, request, "/manifest.bin"));
  return manifest;
}

function decodeChunk(buf) {
  const n = buf.byteLength / 16;
  const words = new Uint32Array(buf, 0, 2 * n);
  const uprn = new Float64Array(n);
  let acc = words[0] + words[1] * 4294967296;
  uprn[0] = acc;
  for (let i = 1; i < n; i++) {
    acc += words[2 * i] + words[2 * i + 1] * 4294967296;
    uprn[i] = acc;
  }
  return { n, uprn, lat: new Int32Array(buf, 8 * n, n), lng: new Int32Array(buf, 12 * n, n) };
}

async function getChunk(env, request, idx) {
  let c = chunks.get(idx);
  if (!c) {
    c = decodeChunk(await asset(env, request, `/d/${String(idx).padStart(4, "0")}.bin`));
    // Bound the per-isolate cache; chunks are ~128 KiB decoded.
    if (chunks.size >= 8) chunks.delete(chunks.keys().next().value);
    chunks.set(idx, c);
  }
  return c;
}

function chunkFor(man, target) {
  let lo = 0, hi = man.length - 1, found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (man[mid] <= target) { found = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return found;
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

    const target = Number(m[1]);
    if (!Number.isSafeInteger(target)) return json({ error: "Invalid UPRN" }, 400);

    try {
      const man = await getManifest(env, request);
      const idx = chunkFor(man, target);
      if (idx < 0) return json({ error: "Not found", uprn: m[1] }, 404);
      const c = await getChunk(env, request, idx);
      let lo = 0, hi = c.n - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1, u = c.uprn[mid];
        if (u === target) {
          return json({ uprn: String(target), lat: c.lat[mid] / SCALE, lng: c.lng[mid] / SCALE });
        }
        if (u < target) lo = mid + 1; else hi = mid - 1;
      }
      return json({ error: "Not found", uprn: m[1] }, 404);
    } catch (err) {
      console.error("lookup failed", err.stack || String(err));
      return json({ error: "Lookup failed" }, 500);
    }
  },
};
