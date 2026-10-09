// Vercel serverless entry point. vercel.json rewrites every /api/* request here and
// passes the original path as ?__route=..., so restore req.url before handling it.
const { handleApi } = require("../lib/app");

module.exports = (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const route = url.searchParams.get("__route");
  if (route !== null) {
    url.searchParams.delete("__route");
    req.url = "/api/" + route.replace(/^\/+/, "") + url.search;
  }
  return handleApi(req, res);
};
