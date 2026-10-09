// Invites every WildApricot registrant who has no Sched account on this event.
//
//   node scripts/sched-sync.js                      preview: looks everyone up (read-only) and writes
//                                                   reports/sched-invite-preview.csv. Sends nothing.
//   node scripts/sched-sync.js --apply --limit 3    invite only the first 3 people on the list
//   node scripts/sched-sync.js --apply              invite everyone on the list
//   node scripts/sched-sync.js --test-email you+test@example.com
//                                                   invite one test address as "<your badge name> (test)"
//                                                   so you can see the email Sched sends
//
// Options: --skip-type "Special Registration"  leave out registration types containing this text
//          --only someone@example.com          invite just this registrant
//
// Each invite looks the email up across all of Sched first: people with an account from a past event
// get the attendee role added; everyone else gets a new account. Sched emails each person.
// Paced to stay under Sched's 30-calls-per-minute limit. Safe to rerun: people already on
// aoir26 are skipped. Reports contain names and emails, so reports/ is git-ignored.

const fs = require("fs");
const path = require("path");
require("../lib/env")(path.join(__dirname, "..", ".env"));
const app = require("../lib/app");
const sched = require("../lib/sched");

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const apply = flag("--apply");
const limit = option("--limit") ? Number(option("--limit")) : Infinity;
const skipType = option("--skip-type");
const only = option("--only")?.toLowerCase();
const testEmail = option("--test-email");

const REPORTS = path.join(__dirname, "..", "reports");
const PACE_MS = 2500; // ~24 calls/min, under Sched's 30/min
const norm = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const csvCell = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;

function writeCsv(file, rows) {
  fs.mkdirSync(REPORTS, { recursive: true });
  const header = Object.keys(rows[0] || { name: "" });
  fs.writeFileSync(file, [header.map(csvCell).join(","), ...rows.map((r) => header.map((h) => csvCell(r[h])).join(","))].join("\n") + "\n");
  return path.relative(process.cwd(), file);
}

function person(r) {
  return {
    name: app.fullName(r),
    badgeName: app.badgeName(r),
    email: app.field(r, "Email"),
    affiliation: r.Organization || app.field(r, "Organization"),
    registrationType: app.registrationDetails(r).registrationType,
  };
}

// Looks the email up across all of Sched (read-only) to see which invite path applies.
async function plannedAction(email) {
  try {
    const u = JSON.parse(await sched.sched("user/get", { by: "email", term: email, format: "json", fields: "username,role" }));
    if (/\battendee\b/i.test(u.role || "")) return { action: "already attendee (skip)", username: u.username };
    return { action: "existing Sched account: add attendee role", username: u.username };
  } catch (e) {
    if (e instanceof sched.SchedError && /no such user/i.test(e.message)) return { action: "new Sched account", username: "" };
    throw e;
  }
}

async function invite(p) {
  return sched.inviteToSched({ email: p.email, name: p.badgeName || p.name, company: p.affiliation });
}

(async () => {
  if (!sched.enabled) throw new Error("Missing SCHED_API_KEY in .env");

  if (testEmail) {
    const me = { email: testEmail, name: "Test", badgeName: "Emerson Johnston (test)", affiliation: "Stanford University" };
    console.log(`Test invite to ${testEmail} as "${me.badgeName}"...`);
    console.log("Planned:", (await plannedAction(testEmail)).action);
    await sleep(PACE_MS);
    const res = await invite(me);
    console.log(`Result: ${res.status} | ${res.message}`);
    return;
  }

  const [regs, data] = await Promise.all([app.getRegistrations(true), sched.getSchedData(true)]);

  const toInvite = [];
  let onSched = 0, otherEmail = 0, noEmail = 0, dupes = 0, skippedType = 0;
  const seenEmails = new Set();
  for (const r of regs) {
    const p = person(r);
    const email = p.email.toLowerCase().trim();
    if (!email) { noEmail++; continue; }
    if (seenEmails.has(email)) { dupes++; continue; }
    seenEmails.add(email);
    if (data.byEmail.has(email)) { onSched++; continue; }
    if (data.byName.has(norm(p.name))) { otherEmail++; continue; }
    if (skipType && p.registrationType.toLowerCase().includes(skipType.toLowerCase())) { skippedType++; continue; }
    if (only && email !== only) continue;
    toInvite.push(p);
  }

  console.log(`WildApricot registrants: ${regs.length}`);
  console.log(`  already on aoir26 Sched (same email):  ${onSched}`);
  console.log(`  on aoir26 Sched under another email:   ${otherEmail}`);
  console.log(`  duplicate registrations:               ${dupes}`);
  console.log(`  no email on registration:              ${noEmail}`);
  if (skipType) console.log(`  left out (type contains "${skipType}"):  ${skippedType}`);
  console.log(`  TO INVITE:                             ${toInvite.length}\n`);

  if (!apply) {
    console.log(`Looking up ${toInvite.length} people across Sched (read-only, ~${Math.ceil((toInvite.length * PACE_MS) / 60000)} min)...`);
    const rows = [];
    for (const [i, p] of toInvite.entries()) {
      const plan = await plannedAction(p.email);
      rows.push({ ...p, sentToSchedAs: p.badgeName || p.name, plannedAction: plan.action, existingUsername: plan.username });
      process.stdout.write(`\r  ${i + 1}/${toInvite.length}`);
      await sleep(PACE_MS);
    }
    const tally = {};
    rows.forEach((r) => (tally[r.plannedAction] = (tally[r.plannedAction] || 0) + 1));
    console.log("\n\nPlanned actions:");
    for (const [k, v] of Object.entries(tally)) console.log(`  ${String(v).padStart(4)}  ${k}`);
    console.log(`\nReview file: ${writeCsv(path.join(REPORTS, "sched-invite-preview.csv"), rows)}`);
    console.log("Nothing was sent. Run with --apply (optionally --limit N) to send invites.");
    return;
  }

  const batch = toInvite.slice(0, limit);
  console.log(`Inviting ${batch.length} people (~${Math.ceil((batch.length * 2 * PACE_MS) / 60000)} min)...`);
  const results = [];
  const tally = {};
  for (const [i, p] of batch.entries()) {
    let status, message;
    try {
      ({ status, message } = await invite(p));
    } catch (e) {
      status = "error";
      message = e.message;
    }
    tally[status] = (tally[status] || 0) + 1;
    results.push({ ...p, status, message, at: new Date().toISOString() });
    console.log(`  [${i + 1}/${batch.length}] ${p.name}: ${status}${status === "error" ? " (" + message + ")" : ""}`);
    await sleep(2 * PACE_MS); // each invite uses up to 2 Sched calls
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  console.log(`\nDone: ${JSON.stringify(tally)}`);
  console.log(`Results: ${writeCsv(path.join(REPORTS, `sched-invite-results-${stamp}.csv`), results)}`);
})().catch((e) => {
  console.error("\n" + e.message);
  process.exit(1);
});
