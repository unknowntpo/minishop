const API_BASE_META_NAME = "minishop-api-base-url";

export function buildBrowserApiUrl(pathname: string) {
  const normalizedPath = pathname.startsWith("/") ? pathname : `/${pathname}`;
  const baseUrl = resolveBrowserApiBaseUrl();

  if (!baseUrl) {
    return normalizedPath;
  }

  return new URL(normalizedPath, `${baseUrl}/`).toString();
}

function resolveBrowserApiBaseUrl() {
  if (typeof document !== "undefined") {
    const meta = document.querySelector<HTMLMetaElement>(
      `meta[name="${API_BASE_META_NAME}"]`,
    );
    const content = meta?.content?.trim();

    if (content) {
      return trimTrailingSlash(content);
    }
  }

  const envValue = process.env.NEXT_PUBLIC_API_BASE_URL?.trim();

  if (envValue) {
    return trimTrailingSlash(envValue);
  }

  return "";
}

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, "");
}
