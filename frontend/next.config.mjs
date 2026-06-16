/** @type {import('next').NextConfig} */
const nextConfig = {
  // Static export: `next build` emits a fully static site to ./out, which the
  // FastAPI backend serves. No Node runtime needed in production.
  output: "export",
  typescript: {
    ignoreBuildErrors: true,
  },
  eslint: {
    ignoreDuringBuilds: true,
  },
  images: {
    unoptimized: true,
  },
}

export default nextConfig
