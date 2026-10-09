// Event self check-in server for WildApricot.
// Keeps the API key on the server; the browser only talks to /api/*.

const http = require("http");
const fs = require("fs");
const path = require("path");

loadEnv(path.join(__dirname, ".env"));

const API_KEY = process.env.WA_API_KEY;
const EVENT_ID = process.env.WA_EVENT_ID;
const CHECKIN_CODE = (process.env.CHECKIN_CODE || "").trim(); // optional
const PORT = Number(process.env.PORT || 3000);
const API = "https://api.wildapricot.org/v2.2";

if (!API_KEY || !EVENT_ID || API_KEY === "paste_your_api_key_here") {
  console.error("Missing WA_API_KEY or WA_EVENT_ID. Open the .env file and fill them in.");
  process.exit(1);
}

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

async function wa(method, pathAndQuery, body) {
  const t = await getToken();
  const res = await fetch(`${API}/accounts/${t.accountId}${pathAndQuery}`, {
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

async function getEvent() {
  return wa("GET", `/events/${EVENT_ID}`);
}

// Registrations are cached briefly so a busy door doesn't hit API rate limits.
let regCache = { at: 0, list: [] };

async function getRegistrations(force = false) {
  if (!force && Date.now() - regCache.at < 30_000) return regCache.list;
  // WildApricot can return short pages mid-list (e.g. 99 of 100), so keep paging
  // until a page comes back empty, and de-duplicate by Id.
  const byId = new Map();
  const pageSize = 100;
  for (let skip = 0; ; skip += pageSize) {
    const page = await wa("GET", `/eventregistrations?eventId=${EVENT_ID}&$top=${pageSize}&$skip=${skip}`);
    const items = Array.isArray(page) ? page : page?.EventRegistrations || [];
    if (items.length === 0) break;
    for (const r of items) byId.set(r.Id, r);
  }
  const all = [...byId.values()];
  regCache = { at: Date.now(), list: all };
  return all;
}

async function markCheckedIn(reg) {
  try {
    await wa("PUT", `/eventregistrations/${reg.Id}`, { Id: reg.Id, IsCheckedIn: true });
  } catch (err) {
    // Fallback to the RPC endpoint if the PUT is rejected.
    console.warn("PUT check-in failed, trying RPC:", err.message);
    await wa("POST", `/rpc/CheckInEventAttendee`, { Id: reg.Id, CheckedIn: true });
  }
  reg.IsCheckedIn = true;
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

const normalize = (s) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

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

function registrationDetails(reg) {
  const fields = [];
  for (const spec of SHOW_FIELDS) {
    const f = (reg.RegistrationFields || []).find((f) =>
      f.FieldName.toLowerCase().startsWith(spec.match.toLowerCase())
    );
    let value = f ? fieldValue(f.Value) : "";
    if (!value) continue;
    if (spec.mask) value = mask(value);
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

// ---------- HTTP server ----------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  try {
    if (req.method === "GET" && url.pathname === "/api/event") {
      const ev = await getEvent();
      return json(res, 200, {
        name: ev.Name,
        startDate: ev.StartDate,
        location: ev.Location,
        requiresCode: Boolean(CHECKIN_CODE),
      });
    }

    // Everything below requires the door code (if one is set).
    if (url.pathname.startsWith("/api/") && CHECKIN_CODE) {
      const code = String(req.headers["x-checkin-code"] || "").trim().toLowerCase();
      if (code !== CHECKIN_CODE.toLowerCase()) {
        return json(res, 403, { error: "That check-in code isn't right. Check the sign at the entrance." });
      }
    }

    if (req.method === "GET" && url.pathname === "/api/verify-code") {
      return json(res, 200, { ok: true });
    }

    if (req.method === "GET" && url.pathname === "/api/search") {
      const terms = normalize(url.searchParams.get("q") || "").split(/\s+/).filter(Boolean);
      if (terms.join("").length < 2) return json(res, 200, []);
      const regs = await getRegistrations();
      const results = regs
        .filter((r) => {
          const hay = normalize([fullName(r), badgeName(r), r.DisplayName, r.Contact?.Name].join(" "));
          return terms.every((t) => hay.includes(t));
        })
        .slice(0, 10)
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
      const reg = (await getRegistrations()).find((r) => String(r.Id) === detailMatch[1]);
      if (!reg) return json(res, 404, { error: "Registration not found." });
      return json(res, 200, registrationDetails(reg));
    }

    if (req.method === "POST" && url.pathname === "/api/checkin") {
      const { id } = await readJson(req);
      const reg = (await getRegistrations()).find((r) => String(r.Id) === String(id));
      if (!reg) return json(res, 404, { error: "Registration not found. Please see a volunteer." });
      if (reg.IsCheckedIn) return json(res, 200, { status: "already", name: fullName(reg) });
      await markCheckedIn(reg);
      console.log(`Checked in: ${fullName(reg)} (registration ${reg.Id})`);
      return json(res, 200, { status: "ok", name: fullName(reg) });
    }

    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return fs.createReadStream(path.join(__dirname, "public", "index.html")).pipe(res);
    }

    json(res, 404, { error: "Not found" });
  } catch (err) {
    console.error(err);
    json(res, 500, { error: "Something went wrong. Please see a volunteer." });
  }
});

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function readJson(req) {
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

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

// `node server.js --test` verifies credentials and lists registrations without checking anyone in.
if (process.argv.includes("--test")) {
  (async () => {
    const ev = await getEvent();
    const regs = await getRegistrations(true);
    console.log(`Event: ${ev.Name} (${ev.StartDate})`);
    console.log(`Registrations: ${regs.length}`);
    for (const r of regs) {
      const d = registrationDetails(r);
      console.log(`  ${d.checkedIn ? "[x]" : "[ ]"} ${d.name}${d.registrationType ? "  (" + d.registrationType + ")" : ""}`);
    }
  })().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
} else {
  server.listen(PORT, () => console.log(`Check-in page running at http://localhost:${PORT}`));
}
