export function buildBuyerWebUrl(pathname: string, search?: URLSearchParams | null) {
  const rawBaseUrl = process.env.BUYER_WEB_BASE_URL?.trim();

  if (!rawBaseUrl) {
    return null;
  }

  const baseUrl = rawBaseUrl.replace(/\/+$/, "");
  const normalizedPath = pathname.startsWith("/") ? pathname : `/${pathname}`;
  const url = new URL(normalizedPath, `${baseUrl}/`);

  if (search) {
    url.search = search.toString();
  }

  return url.toString();
}
