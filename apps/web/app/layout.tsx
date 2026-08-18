import type { Metadata } from 'next';
import { Space_Grotesk, Space_Mono } from 'next/font/google';
import './globals.css';
import Providers from '../components/Providers';
import Nav from '../components/Nav';

const ui = Space_Grotesk({ subsets: ['latin'], weight: ['500', '700'], variable: '--font-ui' });
const mono = Space_Mono({ subsets: ['latin'], weight: ['400', '700'], variable: '--font-mono' });

export const metadata: Metadata = {
  title: 'MagicPad',
  description: 'The launchpad that pays you to trade. Dark bonding, gasless trades, 10% rakeback on losses.',
};

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
