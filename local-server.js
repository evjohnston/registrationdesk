// Local server: serves the page and the API on http://localhost:3000.
// On Vercel, public/ is served directly and api/index.js handles /api/*.

const http = require("http");
const fs = require("fs");
const path = require("path");

require("./lib/env")(path.join(__dirname, ".env"));

const app = require("./lib/app");
const PORT = Number(process.env.PORT || 3000);
const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

if (!app.configured) {
  console.error("Missing WA_API_KEY or WA_EVENT_ID. Open the .env file and fill them in.");
  process.exit(1);
}

// `node local-server.js --test` verifies credentials and lists registrations without checking anyone in.
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
      // Serve files from public/, like Vercel does.
      const publicDir = path.join(__dirname, "public");
      const urlPath = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
      let file = path.join(publicDir, urlPath === "/" ? "index.html" : urlPath);
      if (!path.extname(file)) file += ".html"; // clean URLs, e.g. /desk -> desk.html (same as Vercel)
      if (req.method === "GET" && file.startsWith(publicDir + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) {
        res.writeHead(200, { "Content-Type": MIME_TYPES[path.extname(file)] || "application/octet-stream" });
        return fs.createReadStream(file).pipe(res);
      }
      res.writeHead(404).end("Not found");
    })
    .listen(PORT, () => console.log(`Check-in page running at http://localhost:${PORT}`));
}
