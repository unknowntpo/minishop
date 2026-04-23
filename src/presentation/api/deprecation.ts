const defaultSunset = "2026-12-31";

export function deprecatedGoApiHeaders(pathname: string) {
  return {
    Deprecation: "true",
    Sunset: defaultSunset,
    Link: `</go-api${pathname}>; rel="successor-version"`,
  };
}
