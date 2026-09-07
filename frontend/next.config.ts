import type { NextConfig } from "next";

const backendUrl =
  process.env.NODE_ENV === "production"
    ? "https://unai-test.onrender.com"
    : (process.env.BACKEND_URL || "http://localhost:4000");

const rtlsUrl = "https://rtls.lailab.online";

const nextConfig: NextConfig = {
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: `${backendUrl}/api/:path*`,
      },
      {
        source: "/uploads/:path*",
        destination: `${rtlsUrl}/uploads/:path*`,
      },
    ];
  },
};

export default nextConfig;