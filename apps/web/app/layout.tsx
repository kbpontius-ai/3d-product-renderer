import type { Metadata } from 'next';
import './globals.css';
import './workspace.css';

export const metadata: Metadata = {
  title: '3D Product Renderer',
  description: 'Place artwork on real product geometry and export photorealistic renders.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        {/*
          * The latin subset is on the critical path for every page, and `font-display: swap` means
          * the alternative is a visible reflow from the fallback rather than a slower first paint.
          * latin-ext is deliberately not preloaded: most pages never contain a character from it.
          */}
        <link
          rel="preload"
          href="/fonts/inter-latin-var.woff2"
          as="font"
          type="font/woff2"
          crossOrigin="anonymous"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
