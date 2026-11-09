/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Next's own dev-tools badge, off. It floats over the editor's own corners, and clicking it opens
  // a panel across the app — which reads as a bug in this product rather than a control belonging to
  // the framework. Development only; it has never been part of a build. `next dev --turbo` and the
  // browser devtools cover what it offered.
  devIndicators: false,
  // Workspace packages are consumed as TypeScript source: one build, one set of types, no dist step.
  transpilePackages: [
    '@pr/artwork',
    '@pr/cad',
    '@pr/design-schema',
    '@pr/face-view',
    '@pr/materials',
    '@pr/placement',
    '@pr/render-spec',
    '@pr/scene',
  ],
  webpack: (config) => {
    // Workspace sources use ESM-style ".js" specifiers that resolve to ".ts" files.
    config.resolve.extensionAlias = { '.js': ['.ts', '.tsx', '.js'] };
    return config;
  },
};

export default nextConfig;
