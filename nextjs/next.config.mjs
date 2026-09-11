/** @type {import('next').NextConfig} */
export default {
  // src/ lives outside this app dir; Next needs opt-in to compile it
  experimental: { externalDir: true },
  // don't regenerate AGENTS.md / CLAUDE.md in nextjs/
  agentRules: false,
  // The public site is the offline preview only; the intake page and the
  // model-backed API are reachable on localhost but not through the tunnel
  // (see ~/.cloudflared/config.yml).
  redirects: async () => [{ source: "/", destination: "/preview", permanent: false }],
};
