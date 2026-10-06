// Cloudflare Worker — Yahoo OAuth broker for Waiver Wire
// ---------------------------------------------------------------------------
// Deploy: Cloudflare dashboard → Workers & Pages → Create Worker → paste this.
// Then Settings → Variables → add secrets:
//   YAHOO_CLIENT_ID, YAHOO_CLIENT_SECRET  (from developer.yahoo.com/apps)
// No other config needed. SITE_URL is hardcoded below.
//
// Flow:
//   Site  →  GET /auth/start            →  302 to Yahoo login
//   Yahoo →  GET /auth/callback?code=…  →  302 back to site with tokens in #fragment
//   Site  →  GET /api/leagues           →  [{league_key, name}]      (Bearer token)
//   Site  →  GET /api/freeagents?league_key=… → {available:[names]}  (Bearer token)
//   Site  →  POST /auth/refresh {refresh_token} → {access_token,…}   (to rotate hourly tokens)
//
// The client secret never leaves this worker. Each visitor gets their own
// Yahoo tokens, stored in their own browser localStorage.

const SITE_URL = "https://kennyxli.github.io/injury-wire";
const YAHOO_AUTH = "https://api.login.yahoo.com/oauth2/request_auth";
const YAHOO_TOKEN = "https://api.login.yahoo.com/oauth2/get_token";
const YAHOO_API = "https://fantasysports.yahooapis.com/fantasy/v2";

const CORS = {
  "Access-Control-Allow-Origin": SITE_URL,
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type,Authorization",
};

const norm = n => (n || "").toLowerCase().replace(/\./g, "").trim();

async function yahooGet(path, accessToken) {
  const r = await fetch(`${YAHOO_API}${path}?format=json`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (r.status === 401) throw new Error("unauthorized");
  if (!r.ok) throw new Error(`yahoo ${r.status}`);
  return r.json();
}

// Yahoo's JSON nests everything; walk defensively.
function extractLeagues(j) {
  try {
    const users = j.fantasy_content.users;
    const user = users["0"].user;
    const games = user.find(x => x && x.games).games;
    const game = games["0"].game;
    const leagues = game.find(x => x && x.leagues).leagues;
    const out = [];
    for (const k of Object.keys(leagues)) {
      if (k === "count") continue;
      const l = leagues[k].league[0];
      out.push({ league_key: l.league_key, name: l.name });
    }
    return out;
  } catch (e) { return []; }
}

function extractPlayers(j) {
  const names = [];
  try {
    const league = j.fantasy_content.league;
    const players = league["0"].players;
    for (const k of Object.keys(players)) {
      if (k === "count") continue;
      const p = players[k].player[0];
      const nameObj = p.find(x => x && x.name);
      const teamObj = p.find(x => x && x.editorial_team_abbr);
      const posObj = p.find(x => x && x.display_position);
      if (nameObj) names.push({
        name: norm(nameObj.name.full),
        team: teamObj ? teamObj.editorial_team_abbr : "",
        pos: posObj ? posObj.display_position : "",
      });
    }
  } catch (e) {}
  return names;
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
    const json = (obj, status = 200) =>
      new Response(JSON.stringify(obj), { status, headers: { ...CORS, "Content-Type": "application/json" } });

    // ---- OAuth start ----
    if (url.pathname === "/auth/start") {
      const cb = `${url.origin}/auth/callback`;
      const a = new URL(YAHOO_AUTH);
      a.searchParams.set("client_id", env.YAHOO_CLIENT_ID);
      a.searchParams.set("redirect_uri", cb);
      a.searchParams.set("response_type", "code");
      a.searchParams.set("state", crypto.randomUUID());
      return Response.redirect(a.toString(), 302);
    }

    // ---- OAuth callback → hand tokens to the site via URL fragment ----
    if (url.pathname === "/auth/callback") {
      const code = url.searchParams.get("code");
      if (!code) return new Response("Missing code", { status: 400 });
      const tr = await fetch(YAHOO_TOKEN, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: "Basic " + btoa(`${env.YAHOO_CLIENT_ID}:${env.YAHOO_CLIENT_SECRET}`),
        },
        body: new URLSearchParams({
          code, grant_type: "authorization_code",
          redirect_uri: `${url.origin}/auth/callback`,
        }),
      });
      const tok = await tr.json().catch(() => ({}));
      if (!tok.access_token) return new Response("Token exchange failed", { status: 502 });
      // Fragment never reaches a server — the site's JS reads it and stores locally.
      const dest = `${SITE_URL}#yahoo_access_token=${encodeURIComponent(tok.access_token)}` +
        `&yahoo_refresh_token=${encodeURIComponent(tok.refresh_token || "")}`;
      return Response.redirect(dest, 302);
    }

    // ---- Refresh an expired access token ----
    if (url.pathname === "/auth/refresh" && req.method === "POST") {
      const { refresh_token } = await req.json().catch(() => ({}));
      if (!refresh_token) return json({ error: "missing refresh_token" }, 400);
      const tr = await fetch(YAHOO_TOKEN, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: "Basic " + btoa(`${env.YAHOO_CLIENT_ID}:${env.YAHOO_CLIENT_SECRET}`),
        },
        body: new URLSearchParams({ grant_type: "refresh_token", refresh_token }),
      });
      const tok = await tr.json().catch(() => ({}));
      if (!tok.access_token) return json({ error: "refresh failed" }, 502);
      return json({ access_token: tok.access_token, refresh_token: tok.refresh_token || refresh_token });
    }

    const bearer = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    if (!bearer) return json({ error: "missing bearer token" }, 401);

    // ---- List the visitor's NFL leagues ----
    if (url.pathname === "/api/leagues") {
      try {
        const j = await yahooGet("/users;use_login=1/games;game_codes=nfl/leagues", bearer);
        return json({ leagues: extractLeagues(j) });
      } catch (e) { return json({ error: String(e.message || e) }, e.message === "unauthorized" ? 401 : 502); }
    }

    // ---- Free agents (the actual waiver wire) for one league ----
    if (url.pathname === "/api/freeagents") {
      const league_key = url.searchParams.get("league_key");
      if (!league_key) return json({ error: "missing league_key" }, 400);
      try {
        const seen = new Map();
        for (const pos of ["QB", "RB", "WR", "TE"]) {
          const j = await yahooGet(
            `/league/${encodeURIComponent(league_key)}/players;status=A;position=${pos};count=50`, bearer);
          for (const p of extractPlayers(j)) if (p.name && !seen.has(p.name)) seen.set(p.name, p);
        }
        return json({ league_key, available: [...seen.values()] });
      } catch (e) { return json({ error: String(e.message || e) }, e.message === "unauthorized" ? 401 : 502); }
    }

    return new Response("Not found", { status: 404, headers: CORS });
  },
};
