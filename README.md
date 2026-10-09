# registrationdesk

Self check-in page for a WildApricot event. Attendees search their name, confirm their
badge details, check in, and are sent to the volunteer table for their badge.

The WildApricot API key stays on the server and is never sent to the browser.

## Run locally

```bash
cp .env.example .env   # then fill in WA_API_KEY and WA_EVENT_ID
npm run test-connection  # lists registrants, checks no one in
npm run dev              # http://localhost:3000
```

## Deploy (Vercel)

1. Import this repo at vercel.com/new (Framework preset: Other, no build command).
2. Add environment variables: `WA_API_KEY`, `WA_EVENT_ID`, and optionally `CHECKIN_CODE`.
3. Settings → Domains → add `register.emersonjohnston.org`, then add the CNAME record
   Vercel shows you at GoDaddy (usually `register` → `cname.vercel-dns.com`).

## Pages

- `/` is the attendee self check-in page (for the iPad), with schedule and shop QR codes.
- `/desk` is the volunteer registration desk (needs `DESK_PASSWORD`). It shows full badge details,
  checks people in or undoes it, and, if `SCHED_API_KEY` is set, shows each person's Sched account,
  sessions, and a "Send Sched invite" button.

Every check-in is read back from WildApricot and only reported as saved if it was.

## Sched bulk invite

```bash
node scripts/sched-sync.js           # preview: who has no Sched account
node scripts/sched-sync.js --apply   # create those accounts; Sched emails each person
```

## Layout

- `public/index.html`: the check-in page
- `lib/app.js`: WildApricot calls and the `/api/*` handler
- `lib/sched.js`: Sched API (account status, invites, schedules)
- `public/desk.html`: volunteer desk page
- `scripts/sched-sync.js`: bulk Sched invites
- `api/index.js`: Vercel entry point
- `local-server.js`: local dev server (named so Vercel does not treat it as the app)
