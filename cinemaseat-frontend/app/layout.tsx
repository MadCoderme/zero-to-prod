import { Inter, Oswald } from "next/font/google";
import "./globals.css";

// Setup the body font
const inter = Inter({ 
  subsets: ["latin"], 
  variable: "--font-inter" 
});

// Setup the heading font (Movie poster style)
const oswald = Oswald({ 
  subsets: ["latin"], 
  variable: "--font-oswald" 
});

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${oswald.variable} dark`}>
      <body className="font-sans bg-black text-white antialiased">
        {children}
      </body>
    </html>
  );
}