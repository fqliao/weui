import type { NextConfig } from 'next';
const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  async rewrites() {
    return [
      {
        source: '/api/:path*',
        destination: `${process.env.API_ORIGIN || 'http://127.0.0.1:3101'}/api/:path*`,
      },
    ];
  },
};
export default config;
