const api = process.env.CINEMA_API_URL || "http://127.0.0.1:8000";
/** @type {import('next').NextConfig} */
const nextConfig = { async rewrites() { return [{ source: "/api/:path*", destination: `${api}/:path*` }]; } };
export default nextConfig;
