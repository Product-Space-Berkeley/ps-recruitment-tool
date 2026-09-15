import type { NextConfig } from "next";

// React + Turbopack need 'unsafe-eval' in dev mode; production stays strict.
const isProd = process.env.NODE_ENV === "production";

const commonCsp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isProd ? "" : " 'unsafe-eval'"}`,
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' data: https://fonts.gstatic.com",
  "img-src 'self' data: https:",
  "connect-src 'self'",
  "frame-src 'self' data: blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "upgrade-insecure-requests",
];

const applicationFrameAncestors = [
  "https://plextech.studentorg.berkeley.edu",
  "https://plextech.berkeley.edu",
  ...(process.env.NODE_ENV === "production"
    ? []
    : ["http://localhost:3000", "http://localhost:3001"]),
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
          { key: "X-DNS-Prefetch-Control", value: "off" },
          { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
        ],
      },
      {
        source: "/:path((?!apply(?:/|$)).*)",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          {
            key: "Content-Security-Policy",
            value: [...commonCsp, "frame-ancestors 'none'"].join("; "),
          },
        ],
      },
      {
        source: "/apply/:path*",
        headers: [
          {
            key: "Content-Security-Policy",
            value: [
              ...commonCsp,
              `frame-ancestors ${applicationFrameAncestors.join(" ")}`,
            ].join("; "),
          },
        ],
      },
    ];
  },
};

export default nextConfig;
