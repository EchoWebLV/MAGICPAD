import type { Metadata, Viewport } from 'next';
import { JetBrains_Mono, Zen_Kaku_Gothic_New } from 'next/font/google';
import './globals.css';
import Providers from '../components/Providers';
import Nav from '../components/Nav';

const ui = Zen_Kaku_Gothic_New({
  subsets: ['latin'], weight: ['400', '500', '700', '900'], variable: '--font-ui',
});
const mono = JetBrains_Mono({ subsets: ['latin'], weight: ['400', '500', '700'], variable: '--font-mono' });

export const metadata: Metadata = {
  title: 'MagicPad',
  description: 'The launchpad that pays you to trade. Dark bonding, gasless trades, 10% rakeback on losses.',
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
