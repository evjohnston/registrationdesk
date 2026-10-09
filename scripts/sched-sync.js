// Invites every WildApricot registrant who has no Sched account on this event.
//
//   node scripts/sched-sync.js            preview only: lists who would be invited, changes nothing
//   node scripts/sched-sync.js --apply    creates the accounts; Sched emails each person their login
//
// Paced to stay under Sched's 30-calls-per-minute limit (each invite uses 2 calls).

const path = require("path");
require("../lib/env")(path.join(__dirname, "..", ".env"));
const app = require("../lib/app");
const sched = require("../lib/sched");

const apply = process.argv.includes("--apply");
const norm = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  if (!sched.enabled) throw new Error("Missing SCHED_API_KEY in .env");
  const [regs, data] = await Promise.all([app.getRegistrations(true), sched.getSchedData(true)]);

  const toInvite = [];
  let byEmail = 0, byName = 0, noEmail = 0;
  const seenEmails = new Set();
  for (const r of regs) {
    const email = app.field(r, "Email").toLowerCase().trim();
    if (!email) { noEmail++; continue; }
    if (seenEmails.has(email)) continue; // same person registered twice
    seenEmails.add(email);
    if (data.byEmail.has(email)) { byEmail++; continue; }
    if (data.byName.has(norm(app.fullName(r)))) { byName++; continue; }
    toInvite.push(r);
  }

  console.log(`WildApricot registrants: ${regs.length}`);
  console.log(`  already on Sched (same email):        ${byEmail}`);
  console.log(`  on Sched under a different email:     ${byName}  (skipped; they already have an account)`);
  console.log(`  no email on registration:             ${noEmail}`);
  console.log(`  NO Sched account -> to invite:        ${toInvite.length}\n`);

  for (const r of toInvite) console.log(`  ${apply ? "inviting" : "would invite"}: ${app.fullName(r)} <${app.field(r, "Email")}>`);
  if (!apply) {
    console.log(`\nPreview only. Run with --apply to create these ${toInvite.length} Sched accounts (Sched emails each person).`);
    return;
  }

  console.log(`\nInviting ${toInvite.length} people (about ${Math.ceil((toInvite.length * 5) / 60)} min)...`);
  const tally = {};
  for (const [i, r] of toInvite.entries()) {
    try {
      const res = await sched.inviteToSched({
        email: app.field(r, "Email"),
        name: app.badgeName(r) || app.fullName(r),
        company: r.Organization || app.field(r, "Organization"),
      });
      tally[res.status] = (tally[res.status] || 0) + 1;
      console.log(`  [${i + 1}/${toInvite.length}] ${app.fullName(r)}: ${res.status}`);
    } catch (e) {
      tally.error = (tally.error || 0) + 1;
      console.log(`  [${i + 1}/${toInvite.length}] ${app.fullName(r)}: ERROR ${e.message}`);
    }
    await sleep(5000);
  }
  console.log("\nDone:", JSON.stringify(tally));
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
