// Coordinates are stored as integers scaled by 1e7 - SQLite REALs would cost
// 8 bytes each and buy no precision the source data actually has (7 dp).
const SCALE = 1e7;

const json = (body, status = 200) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      // Same-origin for the bundled page, but the API is public and useful
      // to other callers, so allow cross-origin reads too.
      "access-control-allow-origin": "*",
      "cache-control": status === 200 ? "public, max-age=86400" : "no-store",
    },
  });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
    if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);

    const match = url.pathname.match(/^\/api\/uprn\/([0-9]+)\/?$/);
    if (!match) {
      return json({ error: "Not found", usage: "GET /api/uprn/{uprn}" }, 404);
    }

    const uprn = match[1];
    // Max UPRN is ~9.07e11, comfortably inside Number's safe range, but reject
    // anything longer rather than silently losing precision on a bad request.
    if (uprn.length > 12) return json({ error: "UPRN too long" }, 400);

    const row = await env.DB.prepare(
      "SELECT uprn, lat, lng FROM uprn WHERE uprn = ?",
    )
      .bind(Number(uprn))
      .first();

    if (!row) return json({ error: "Not found", uprn }, 404);

    return json({
      uprn: String(row.uprn),
      lat: row.lat / SCALE,
      lng: row.lng / SCALE,
    });
  },
};
