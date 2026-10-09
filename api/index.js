// Vercel serverless entry point. vercel.json routes every /api/* request here.
module.exports = require("../lib/app").handleApi;
