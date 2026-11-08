export type Route = { page: "list" } | { page: "site"; id: string };

/** `#/` is the list; `#/site/<encoded id>` is a site. Anything else is the list. */
export function parseRoute(hash: string): Route {
  const match = /^#\/site\/(.+)$/.exec(hash);
  if (match?.[1] !== undefined) {
    try {
      return { page: "site", id: decodeURIComponent(match[1]) };
    } catch {
      return { page: "list" };
    }
  }
  return { page: "list" };
}

export function siteHref(id: string): string {
  return `#/site/${encodeURIComponent(id)}`;
}
