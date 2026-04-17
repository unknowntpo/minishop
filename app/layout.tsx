import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Minishop",
  description: "Event-sourced checkout experiment",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
