/**
 * Cloudflare Pages serves a static export with no server-side rewrites, so this
 * build no longer proxies /api/* through next.config.mjs. The dashboard instead
 * talks directly to NEXT_PUBLIC_API_URL (the deployed Cloudflare Worker's URL,
 * or http://127.0.0.1:8787 for local `wrangler dev`) — see app/page.tsx.
 */
/** @type {import('next').NextConfig} */
const nextConfig = { output: "export" };
export default nextConfig;
