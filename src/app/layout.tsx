import type { Metadata } from "next";
import { Instrument_Sans } from "next/font/google";
import "./globals.css";
import SessionProvider from "@/components/SessionProvider";

const instrumentSans = Instrument_Sans({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-instrument-sans",
});

export const metadata: Metadata = {
  title: "Login | Product Space @ Berkeley",
  description: "Applications, reviews, and recruitment for Product Space @ Berkeley.",
  icons: { icon: "/product-space-logo.png" },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className="h-full antialiased"
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: `
          try {
            var t = localStorage.getItem('theme');
            var el = document.documentElement;
            el.setAttribute('data-theme', t === 'light' ? 'light' : 'dark');

          } catch(e) {}
        `}} />
      </head>
      <body className={`${instrumentSans.className} ${instrumentSans.variable} min-h-full flex flex-col`}><SessionProvider>{children}</SessionProvider></body>
    </html>
  );
}
