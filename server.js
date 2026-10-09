// Local server: serves the page and the API on http://localhost:3000.
// On Vercel, public/ is served directly and api/index.js handles /api/*.

const http = require("http");
const fs = require("fs");
const path = require("path");

loadEnv(path.join(__dirname, ".env"));

const app = require("./lib/app");
const PORT = Number(process.env.PORT || 3000);

if (!app.configured) {
  console.error("Missing WA_API_KEY or WA_EVENT_ID. Open the .env file and fill them in.");
  process.exit(1);
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
    const ev = await app.getEvent();
    const regs = await app.getRegistrations(true);
    console.log(`Event: ${ev.Name} (${ev.StartDate})`);
    console.log(`Registrations: ${regs.length}`);
    for (const r of regs) {
      const d = app.registrationDetails(r);
      console.log(`  ${d.checkedIn ? "[x]" : "[ ]"} ${d.name}${d.registrationType ? "  (" + d.registrationType + ")" : ""}`);
    }
  })().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
} else {
  http
    .createServer((req, res) => {
      if (req.url.startsWith("/api/")) return app.handleApi(req, res);
      if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        return fs.createReadStream(path.join(__dirname, "public", "index.html")).pipe(res);
      }
      res.writeHead(404).end("Not found");
    })
    .listen(PORT, () => console.log(`Check-in page running at http://localhost:${PORT}`));
}
