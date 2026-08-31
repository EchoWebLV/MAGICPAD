import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Railway hikari was pinning the old HTML for a year (s-maxage=31536000).
  // Tokens live-fetch on the client; the document itself must not be cached.
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'Cache-Control', value: 'no-store, must-revalidate' },
        ],
      },
    ];
  },
};

export default nextConfig;
