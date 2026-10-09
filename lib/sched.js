// Sched (aoir26.sched.com) integration for the volunteer desk: account status, invites,
// and each attendee's schedule. Sched allows 30 API calls per minute per key, so the
// account list and schedules are cached and refreshed in the background.

const SCHED_API_KEY = (process.env.SCHED_API_KEY || "").trim();
const SCHED_SITE = (process.env.SCHED_SITE || "https://aoir26.sched.com").replace(/\/+$/, "");
const enabled = Boolean(SCHED_API_KEY);
const REFRESH_MS = 90_000;

class SchedError extends Error {}

// Sched rejects requests without a User-Agent (HTTP 400, empty body), so always send one.
async function sched(path, params = {}) {
  const url = new URL(`${SCHED_SITE}/api/${path}`);
  url.searchParams.set("api_key", SCHED_API_KEY);
  for (const [k, v] of Object.entries(params)) if (v != null && v !== "") url.searchParams.set(k, v);
  const res = await fetch(url, { headers: { "User-Agent": "registrationdesk (AoIR check-in)" } });
  const text = (await res.text()).trim();
  if (!res.ok) throw new SchedError(`${path} returned HTTP ${res.status}${text ? ": " + text.slice(0, 120) : " (empty response)"}`);
  if (text.startsWith("ERR:")) throw new SchedError(text.slice(4).trim());
  return text;
}

function parseJson(text, path) {
  try {
    return JSON.parse(text);
  } catch {
    throw new SchedError(`${path} didn't return JSON: ${text.slice(0, 120) || "(empty response)"}`);
  }
}

const norm = (s) =>
  String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim();

// ---------- Cached snapshot of Sched data ----------

let cache = { at: 0, data: null };
let inflight = null;

async function getSchedData(force = false) {
  if (!force && cache.data) {
    if (Date.now() - cache.at > REFRESH_MS) {
      const p = refresh().catch((e) => console.error("Sched refresh failed:", e.message));
      globalThis[Symbol.for("@vercel/request-context")]?.get?.()?.waitUntil?.(p); // keep it alive on Vercel
    }
    return cache.data;
  }
  return refresh();
}

function refresh() {
  inflight ??= loadSchedData()
    .then((data) => {
      cache = { at: Date.now(), data };
      return data;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

async function loadSchedData() {
  const [users, picks, sessions] = await Promise.all([
    sched("user/list", { format: "json", fields: "username,name,email,role" }).then((t) => parseJson(t, "user/list")),
    sched("user/sessions", { format: "json" }).then((t) => parseJson(t, "user/sessions")),
    sched("session/list", { format: "json" }).then((t) => parseJson(t, "session/list")),
  ]);

  const byEmail = new Map();
  const byName = new Map(); // only names that belong to exactly one account
  const nameCount = new Map();
  for (const u of users) {
    if (u.email) byEmail.set(u.email.toLowerCase().trim(), u);
    const n = norm(u.name);
    nameCount.set(n, (nameCount.get(n) || 0) + 1);
    byName.set(n, u);
  }
  for (const [n, c] of nameCount) if (c > 1) byName.delete(n);

  const session = (s) => ({ name: s.event_name || s.name, start: s.event_start, end: s.event_end, venue: s.venue || "" });

  const picksByUser = new Map();
  for (const p of picks) {
    if (!picksByUser.has(p.username)) picksByUser.set(p.username, []);
    picksByUser.get(p.username).push(session(p));
  }

  // session/list gives speakers as a comma-separated string of names.
  const speakingByName = new Map();
  for (const s of sessions) {
    if (s.active === "N") continue;
    for (const n of String(s.speakers || "").split(",").map(norm).filter(Boolean)) {
      if (!speakingByName.has(n)) speakingByName.set(n, []);
      speakingByName.get(n).push(session(s));
    }
  }

  return { byEmail, byName, picksByUser, speakingByName };
}

// ---------- What the desk shows ----------

const byStart = (a, b) => String(a.start).localeCompare(String(b.start));

function dedupe(list) {
  const seen = new Set();
  return list.filter((s) => {
    const k = s.name + "|" + s.start;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

async function schedStatus({ email, name }) {
  if (!enabled) return { enabled: false };
  const data = await getSchedData();
  let user = email ? data.byEmail.get(email.toLowerCase().trim()) : null;
  let matchedBy = user ? "email" : null;
  if (!user && name) {
    user = data.byName.get(norm(name)) || null;
    if (user) matchedBy = "name";
  }
  const speaking = dedupe((data.speakingByName.get(norm(user?.name || name)) || []).slice().sort(byStart));
  const picked = user ? dedupe((data.picksByUser.get(user.username) || []).slice().sort(byStart)) : [];
  return {
    enabled: true,
    site: SCHED_SITE.replace(/^https?:\/\//, ""),
    account: user ? { username: user.username, name: user.name, roles: user.role || "", matchedBy } : null,
    speaking,
    // Sessions they added themselves, minus ones they're already speaking in.
    picked: picked.filter((p) => !speaking.some((s) => s.name === p.name && s.start === p.start)),
  };
}

// Gives someone a Sched account on this event (or adds the attendee role to an existing one).
// Sched emails them their login details.
async function inviteToSched({ email, name, company }) {
  if (!enabled) throw new SchedError("Sched isn't set up (missing SCHED_API_KEY).");
  if (!email) throw new SchedError("This registration has no email address to invite.");

  let existing = null;
  try {
    existing = JSON.parse(await sched("user/get", { by: "email", term: email, format: "json", fields: "username,name,email,role" }));
  } catch (e) {
    if (!(e instanceof SchedError) || !/no such user/i.test(e.message)) throw e;
  }

  let result;
  if (existing?.username) {
    if (/\battendee\b/i.test(existing.role || "")) {
      result = { status: "exists", message: `${existing.name || email} already has a Sched account (${existing.username}).` };
    } else {
      await sched("role/add", { username: existing.username, role: "attendee", send_email: 1 });
      result = { status: "role-added", message: `Added the attendee role to their existing Sched account (${existing.username}). Sched emailed them.` };
    }
  } else {
    try {
      await sched("user/add", { email, full_name: name, company, role: "attendee", send_email: 1 });
      result = { status: "created", message: `Created a Sched account and emailed login details to ${email}.` };
    } catch (e) {
      if (e instanceof SchedError && /exist/i.test(e.message)) {
        result = {
          status: "exists-elsewhere",
          message: `${email} already has a Sched account from another event. Ask them to log in at ${SCHED_SITE.replace(/^https?:\/\//, "")} with that account (or use "Forgot password").`,
        };
      } else {
        throw e;
      }
    }
  }
  refresh().catch(() => {}); // pick up the new account on the next lookup
  return result;
}

module.exports = { enabled, SchedError, sched, getSchedData, schedStatus, inviteToSched };
