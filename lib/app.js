// Check-in logic shared by the local server (local-server.js) and Vercel (api/index.js).
// Keeps the API key on the server; the browser only talks to /api/*.

const API_KEY = process.env.WA_API_KEY;
const EVENT_ID = process.env.WA_EVENT_ID;
const CHECKIN_CODE = (process.env.CHECKIN_CODE || "").trim(); // optional
const DESK_PASSWORD = (process.env.DESK_PASSWORD || "").trim(); // required for the volunteer desk page
const API = "https://api.wildapricot.org/v2.2";

const configured = Boolean(API_KEY && EVENT_ID && API_KEY !== "paste_your_api_key_here");

// ---------- WildApricot API ----------

let token = null; // { accessToken, accountId, expiresAt }

async function getToken() {
  if (token && Date.now() < token.expiresAt - 60_000) return token;
  const res = await fetch("https://oauth.wildapricot.org/auth/token", {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from("APIKEY:" + API_KEY).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials&scope=auto",
  });
  if (!res.ok) throw new Error(`Auth failed (${res.status}): ${await res.text()}`);
  const data = await res.json();
  token = {
    accessToken: data.access_token,
    accountId: data.Permissions[0].AccountId,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
  return token;
}

// pathAndQuery is relative to /accounts/{id}, unless it starts with /rpc/ (RPC calls live at /rpc/{id}/...).
async function wa(method, pathAndQuery, body) {
  const t = await getToken();
  const url = pathAndQuery.startsWith("/rpc/")
    ? `${API}/rpc/${t.accountId}${pathAndQuery.slice(4)}`
    : `${API}/accounts/${t.accountId}${pathAndQuery}`;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: "Bearer " + t.accessToken,
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${pathAndQuery} -> ${res.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

// Event details rarely change, so keep them for 10 minutes.
let eventCache = { at: 0, event: null };

async function getEvent() {
  if (eventCache.event && Date.now() - eventCache.at < 10 * 60_000) return eventCache.event;
  const event = await wa("GET", `/events/${EVENT_ID}`);
  eventCache = { at: Date.now(), event };
  return event;
}

// Registrations are cached so searches answer instantly. Once the cache is older than
// REFRESH_MS, the stale list is still served while a fresh copy loads in the background.
const REFRESH_MS = 15_000;
let regCache = { at: 0, list: null };
let inflight = null;

async function getRegistrations(force = false) {
  if (force || !regCache.list) return loadRegistrations();
  if (Date.now() - regCache.at > REFRESH_MS) {
    runInBackground(loadRegistrations().catch((err) => console.error("Background refresh failed:", err.message)));
  }
  return regCache.list;
}

function loadRegistrations() {
  inflight ??= fetchAllRegistrations()
    .then((list) => {
      regCache = { at: Date.now(), list };
      return list;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

// Fetches pages in parallel batches. WildApricot can return short pages mid-list
// (e.g. 99 of 100), so keep going until a page comes back empty, and de-duplicate by Id.
async function fetchAllRegistrations() {
  const byId = new Map();
  const pageSize = 100;
  const batch = 8;
  for (let start = 0; ; start += batch) {
    const pages = await Promise.all(
      Array.from({ length: batch }, (_, i) =>
        wa("GET", `/eventregistrations?eventId=${EVENT_ID}&$top=${pageSize}&$skip=${(start + i) * pageSize}`)
      )
    );
    let reachedEnd = false;
    for (const page of pages) {
      const items = Array.isArray(page) ? page : page?.EventRegistrations || [];
      if (items.length === 0) reachedEnd = true;
      for (const r of items) byId.set(r.Id, r);
    }
    if (reachedEnd) return [...byId.values()];
  }
}

// Finds a registration by Id, reloading once if it isn't in the cached list
// (e.g. someone who registered after the list was last loaded).
async function findRegistration(id) {
  const match = (list) => list.find((r) => String(r.Id) === String(id));
  return match(await getRegistrations()) || match(await getRegistrations(true));
}

// Keeps a promise alive after the response is sent. On Vercel this uses the platform's
// waitUntil (the same hook @vercel/functions uses); locally the process just keeps running.
function runInBackground(promise) {
  globalThis[Symbol.for("@vercel/request-context")]?.get?.()?.waitUntil?.(promise);
}

// Reads one registration straight from WildApricot (the source of truth when several
// devices are checking people in) and updates this server's cached copy with it.
async function getFreshRegistration(id) {
  const fresh = await wa("GET", `/eventregistrations/${id}`);
  if (regCache.list) {
    const i = regCache.list.findIndex((r) => String(r.Id) === String(id));
    if (i >= 0) regCache.list[i] = fresh;
  }
  return fresh;
}

// Uses WildApricot's dedicated check-in call, which only touches the check-in flag
// (a full PUT of the registration could disturb other registration data), then reads the
// registration back to confirm WildApricot actually saved it.
async function setCheckedIn(id, checkedIn) {
  await wa("POST", `/rpc/CheckInEventAttendee`, { RegistrationId: Number(id), CheckedIn: checkedIn });
  const fresh = await getFreshRegistration(id);
  if (Boolean(fresh.IsCheckedIn) !== checkedIn) {
    throw new Error(`WildApricot did not save check-in=${checkedIn} for registration ${id}`);
  }
  return fresh;
}

// ---------- Registration helpers ----------

function fieldValue(v) {
  if (v == null) return "";
  if (Array.isArray(v)) return v.map(fieldValue).filter(Boolean).join(", ");
  if (typeof v === "object") return v.Label ?? v.Value ?? v.Name ?? "";
  return String(v).trim();
}

function field(reg, ...codes) {
  const f = (reg.RegistrationFields || []).find((f) => codes.includes(f.SystemCode) || codes.includes(f.FieldName));
  return f ? fieldValue(f.Value) : "";
}

function fullName(reg) {
  const first = field(reg, "FirstName", "First name");
  const last = field(reg, "LastName", "Last name");
  return [first, last].filter(Boolean).join(" ") || reg.Contact?.Name || reg.DisplayName || "Registrant";
}

const normalize = (s) => s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

// Hide most of an email/phone so the public page doesn't leak contact info.
function mask(value) {
  if (value.includes("@")) {
    const [user, domain] = value.split("@");
    return user.slice(0, 1) + "•••@" + domain;
  }
  const digits = value.replace(/\D/g, "");
  if (digits.length >= 7) return "•••-" + digits.slice(-4);
  return value;
}

// Only these registration form fields are shown on the confirm screen (matched by the start
// of the field name, case-insensitive). Health, dietary, and upload fields are deliberately left off.
const SHOW_FIELDS = [
  { match: "Preferred name for badge", label: "Name on badge" },
  { match: "Preferred pronouns for badge", label: "Pronouns on badge" },
  { match: "Institution / Affiliation", label: "Affiliation" },
  { match: "Country of Residence", label: "Country" },
  { match: "Morning session", label: "Wed. morning session" },
  { match: "Afternoon session", label: "Wed. afternoon session" },
  { match: "Account Email", label: "Email", mask: true },
];

function registrationDetails(reg, { maskContact = true } = {}) {
  const fields = [];
  for (const spec of SHOW_FIELDS) {
    const f = (reg.RegistrationFields || []).find((f) =>
      f.FieldName.toLowerCase().startsWith(spec.match.toLowerCase())
    );
    let value = f ? fieldValue(f.Value) : "";
    if (!value) continue;
    if (spec.mask && maskContact) value = mask(value);
    fields.push({ label: spec.label, value });
  }
  return {
    id: reg.Id,
    name: fullName(reg),
    registrationType: (reg.RegistrationType?.Name || "")
      .replace(/\[Code Required\]|USD \(\$\)/gi, "")
      .trim(),
    checkedIn: Boolean(reg.IsCheckedIn),
    fields,
  };
}

function badgeName(reg) {
  return field(reg, "Preferred name for badge:", "Preferred name for badge");
}

function searchRegistrations(regs, query, limit) {
  const terms = normalize(query || "").split(/\s+/).filter(Boolean);
  if (terms.join("").length < 2) return [];
  return regs
    .filter((r) => {
      const hay = normalize([fullName(r), badgeName(r), r.DisplayName, r.Contact?.Name].join(" "));
      return terms.every((t) => hay.includes(t));
    })
    .slice(0, limit);
}

// ---------- Volunteer desk API (/api/desk/*) ----------
// Password-protected; shows full (unmasked) badge details and lets volunteers check people in or undo.

async function handleDesk(req, res, url) {
  if (!DESK_PASSWORD) {
    return json(res, 503, { error: "The desk page isn't set up yet (missing DESK_PASSWORD)." });
  }
  if (String(req.headers["x-desk-password"] || "") !== DESK_PASSWORD) {
    return json(res, 401, { error: "Wrong desk password." });
  }
  const volunteer = String(req.headers["x-volunteer"] || "unknown").slice(0, 60);

  if (req.method === "GET" && url.pathname === "/api/desk/verify") {
    return json(res, 200, { ok: true });
  }

  if (req.method === "GET" && url.pathname === "/api/desk/stats") {
    const regs = await getRegistrations();
    return json(res, 200, { total: regs.length, checkedIn: regs.filter((r) => r.IsCheckedIn).length });
  }

  if (req.method === "GET" && url.pathname === "/api/desk/search") {
    const results = searchRegistrations(await getRegistrations(), url.searchParams.get("q"), 25).map((r) => ({
      id: r.Id,
      name: fullName(r),
      badgeName: badgeName(r),
      organization: r.Organization || field(r, "Organization"),
      checkedIn: Boolean(r.IsCheckedIn),
    }));
    return json(res, 200, results);
  }

  const detailMatch = url.pathname.match(/^\/api\/desk\/registration\/(\d+)$/);
  if (req.method === "GET" && detailMatch) {
    const reg = await getFreshRegistration(detailMatch[1]);
    return json(res, 200, { ...registrationDetails(reg, { maskContact: false }), paymentStatus: reg.Status || "" });
  }

  if (req.method === "POST" && (url.pathname === "/api/desk/checkin" || url.pathname === "/api/desk/undo")) {
    const { id } = await readJson(req);
    if (!/^\d+$/.test(String(id))) return json(res, 400, { error: "Missing registration id." });
    const checkingIn = url.pathname === "/api/desk/checkin";
    const current = await getFreshRegistration(id);
    const name = fullName(current);
    if (checkingIn && current.IsCheckedIn) {
      // Another volunteer (or the iPad) got there first.
      return json(res, 409, { status: "already", ...registrationDetails(current, { maskContact: false }) });
    }
    const updated = await setCheckedIn(id, checkingIn);
    console.log(`[desk] ${volunteer} ${checkingIn ? "checked in" : "UNDID check-in for"} ${name} (registration ${id})`);
    return json(res, 200, { status: checkingIn ? "ok" : "undone", ...registrationDetails(updated, { maskContact: false }), paymentStatus: updated.Status || "" });
  }

  return json(res, 404, { error: "Not found" });
}


// ---------- Request handler (/api/*) ----------

async function handleApi(req, res) {
  const url = new URL(req.url, "http://localhost");
  try {
    if (!configured) {
      return json(res, 500, { error: "Check-in isn't configured yet (missing WA_API_KEY or WA_EVENT_ID)." });
    }

    if (req.method === "GET" && url.pathname === "/api/event") {
      const ev = await getEvent();
      // Let Vercel's CDN cache this so page loads don't wait on WildApricot.
      return json(
        res,
        200,
        { name: ev.Name, startDate: ev.StartDate, location: ev.Location, requiresCode: Boolean(CHECKIN_CODE) },
        "public, s-maxage=300, stale-while-revalidate=86400"
      );
    }

    // Called when the page opens so the registration list is loaded before the first search.
    if (req.method === "POST" && url.pathname === "/api/warm") {
      await getRegistrations();
      return json(res, 200, { ok: true });
    }

    if (url.pathname.startsWith("/api/desk/")) return await handleDesk(req, res, url);

    // Everything below requires the door code (if one is set).
    if (CHECKIN_CODE) {
      const code = String(req.headers["x-checkin-code"] || "").trim().toLowerCase();
      if (code !== CHECKIN_CODE.toLowerCase()) {
        return json(res, 403, { error: "That check-in code isn't right. Check the sign at the entrance." });
      }
    }

    if (req.method === "GET" && url.pathname === "/api/verify-code") {
      return json(res, 200, { ok: true });
    }

    if (req.method === "GET" && url.pathname === "/api/search") {
      const results = searchRegistrations(await getRegistrations(), url.searchParams.get("q"), 10)
        .map((r) => ({
          id: r.Id,
          name: fullName(r),
          organization: r.Organization || field(r, "Organization"),
          checkedIn: Boolean(r.IsCheckedIn),
        }));
      return json(res, 200, results);
    }

    const detailMatch = url.pathname.match(/^\/api\/registration\/(\d+)$/);
    if (req.method === "GET" && detailMatch) {
      const reg = await findRegistration(detailMatch[1]);
      if (!reg) return json(res, 404, { error: "Registration not found." });
      return json(res, 200, registrationDetails(reg));
    }

    if (req.method === "POST" && url.pathname === "/api/checkin") {
      const { id } = await readJson(req);
      const cached = await findRegistration(id);
      if (!cached) return json(res, 404, { error: "Registration not found. Please see a volunteer." });
      const reg = await getFreshRegistration(cached.Id);
      if (reg.IsCheckedIn) return json(res, 200, { status: "already", name: fullName(reg) });
      await setCheckedIn(reg.Id, true);
      console.log(`[ipad] Checked in: ${fullName(reg)} (registration ${reg.Id})`);
      return json(res, 200, { status: "ok", name: fullName(reg) });
    }

    json(res, 404, { error: "Not found" });
  } catch (err) {
    console.error(err);
    json(res, 500, {
      error: url.pathname.startsWith("/api/desk/")
        ? "WildApricot didn't respond as expected."
        : "Something went wrong. Please see a volunteer.",
    });
  }
}

function json(res, status, body, cacheControl = "no-store") {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": cacheControl });
  res.end(JSON.stringify(body));
}

function readJson(req) {
  // Vercel pre-parses JSON bodies; the local server doesn't.
  if (req.body !== undefined) {
    return Promise.resolve(typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {});
  }
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 10_000) req.destroy();
    });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(e);
      }
    });
  });
}

module.exports = { handleApi, configured, getEvent, getRegistrations, registrationDetails };
