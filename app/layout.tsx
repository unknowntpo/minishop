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
  const apiBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL?.trim() ?? "";

  return (
    <html lang="zh-Hant-TW">
      <head>
        <meta name="minishop-api-base-url" content={apiBaseUrl} />
      </head>
      <body>{children}</body>
    </html>
  );
}
