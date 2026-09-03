/** @type {import('next').NextConfig} */
export default {
  // src/ lives outside this app dir; Next needs opt-in to compile it
  experimental: { externalDir: true },
  // don't regenerate AGENTS.md / CLAUDE.md in nextjs/
  agentRules: false,
};
