/** @type {import("next").NextConfig} */
const config = {
  poweredByHeader: false,
  distDir: process.env.EVIANTA_E2E === "1" ? ".next-e2e" : ".next",
};

export default config;
