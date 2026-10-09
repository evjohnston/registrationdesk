# registrationdesk

Self check-in page for a WildApricot event. Attendees search their name, confirm their
badge details, check in, and are sent to the volunteer table for their badge.

The WildApricot API key stays on the server and is never sent to the browser.

## Run locally

```bash
cp .env.example .env   # then fill in WA_API_KEY and WA_EVENT_ID
npm run test-connection  # lists registrants, checks no one in
npm start                # http://localhost:3000
```

## Deploy (Vercel)

1. Import this repo at vercel.com/new (Framework preset: Other, no build command).
2. Add environment variables: `WA_API_KEY`, `WA_EVENT_ID`, and optionally `CHECKIN_CODE`.
3. Settings → Domains → add `register.emersonjohnston.org`, then add the CNAME record
   Vercel shows you at GoDaddy (usually `register` → `cname.vercel-dns.com`).

## Layout

- `public/index.html`: the check-in page
- `lib/app.js`: WildApricot calls and the `/api/*` handler
- `api/index.js`: Vercel entry point
- `server.js`: local dev server
