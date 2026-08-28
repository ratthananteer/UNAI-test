import type { NextConfig } from "next";

const backendUrl = process.env.BACKEND_URL || "https://unai-test.onrender.com";

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
