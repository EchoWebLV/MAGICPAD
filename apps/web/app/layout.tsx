import type { Metadata, Viewport } from 'next';
import { JetBrains_Mono, Plus_Jakarta_Sans } from 'next/font/google';
import './globals.css';
import Providers from '../components/Providers';
import Nav from '../components/Nav';

const ui = Plus_Jakarta_Sans({
  subsets: ['latin'], weight: ['400', '500', '600', '700', '800'], variable: '--font-ui',
});
const mono = JetBrains_Mono({ subsets: ['latin'], weight: ['400', '500', '700'], variable: '--font-mono' });

export const metadata: Metadata = {
  title: 'Mooner',
  description: 'Launch your token in minutes. Bond in the dark, graduate in the light.',
};

export const viewport: Viewport = { themeColor: '#0a0a0a', colorScheme: 'dark' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${ui.variable} ${mono.variable}`}>
      <body>
        <Providers>
          <Nav />
          {children}
        </Providers>
      </body>
    </html>
  );
}
