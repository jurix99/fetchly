import { Analytics } from '@vercel/analytics/next'
import type { Metadata, Viewport } from 'next'
// Use the self-contained `geist` package (fonts bundled in node_modules) rather
// than next/font/google, which fetches from fonts.googleapis.com at build time
// and fails behind the corporate proxy.
import { GeistSans } from 'geist/font/sans'
import { GeistMono } from 'geist/font/mono'
import './globals.css'
import { ThemeProvider } from '@/components/theme-provider'
import { StoreProvider } from '@/components/store-provider'
import { TooltipProvider } from '@/components/ui/tooltip'
import { Toaster } from '@/components/ui/sonner'

const geistSans = GeistSans
const geistMono = GeistMono

export const metadata: Metadata = {
  title: 'Fetchly — Gestionnaire de téléchargement vidéo',
  description:
    'Téléchargez, convertissez et organisez vos vidéos depuis YouTube et des milliers de sites. File d\'attente, abonnements et automatisation.',
  generator: 'v0.app',
}

export const viewport: Viewport = {
  colorScheme: 'dark light',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f7f8fa' },
    { media: '(prefers-color-scheme: dark)', color: '#16181f' },
  ],
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html
      lang="fr"
      className={`dark ${geistSans.variable} ${geistMono.variable}`}
      suppressHydrationWarning
    >
      <body className="font-sans antialiased bg-background text-foreground">
        <ThemeProvider>
          <StoreProvider>
            <TooltipProvider delay={200}>
              {children}
              <Toaster position="bottom-right" />
            </TooltipProvider>
          </StoreProvider>
        </ThemeProvider>
        {process.env.NODE_ENV === 'production' && <Analytics />}
      </body>
    </html>
  )
}
