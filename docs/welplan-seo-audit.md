# Welplan SEO audit

## Scope

This worktree is `discord-opencode-bot`, not the Welplan website (`package.json:2-6`; Git remote `pmh-only/bro`). It contains no Welplan source or project mapping (`projects.example.json` has only a placeholder). Under the current-project-only constraint, Welplan's public pages, production domain, redirects, and rendered HTML could not be inspected. The findings below cover the only web application in this repository: the Bro operational dashboard.

The dashboard exposes private job activity rather than public marketing content. Its SEO objective should be exclusion from search, not ranking.

## Findings

| Priority | Finding | Evidence | Recommendation |
| --- | --- | --- | --- |
| Critical | The server-rendered dashboard can be indexed if port 8080 is publicly reachable. It has no authentication, `noindex`, or `X-Robots-Tag`, and renders project names, requests, responses, and session links. `Cache-Control: no-store` does not prohibit indexing. | `src/web.ts:45-81`, `src/web.ts:93-141`, `src/web.ts:144-168`; `Dockerfile:128`; `README.md:27-31` | Keep the port behind authentication or a private network. Also send `X-Robots-Tag: noindex, nofollow, noarchive, nosnippet` on every dashboard/API response as defense in depth. Access control remains mandatory because robots directives are not confidentiality controls. |
| High | OpenCode session URLs are ordinary crawlable links. `rel="noreferrer"` does not prevent crawling. | `src/web.ts:69-70`, `src/web.ts:127` | Require authentication on the session service and dashboard. Add `nofollow` to the link as defense in depth, or omit session links from remotely exposed views. |
| High | Query variants create duplicate 200 pages without canonicals. Unknown `?project=` values silently render the first project, allowing unlimited duplicate URLs. | `src/web.ts:105-115`, `src/web.ts:164-168` | For a private dashboard, rely on response-level `noindex` and return 404 for unknown project aliases. If this UI ever becomes public, use stable path routes and emit an absolute self-canonical for each valid page. |
| Medium | `/robots.txt` and `/sitemap.xml` fall through to the generic 404. There are no crawler directives anywhere in the repository. | `src/web.ts:149-173` | Serve `robots.txt` with `User-agent: *` and `Disallow: /` as a crawl-budget hint. Do not publish a sitemap for this private UI. Do not use robots exclusion instead of authentication or `noindex`, because blocked URLs can still appear in results. |
| Medium | All visible dashboard content is dynamic SSR and immediately indexable HTML. A 15-second meta refresh continually changes the same URLs, while completed job visibility can also change. | `src/web.ts:105-141`, `src/web.ts:164-168` | Treat all dashboard routes, JSON endpoints, health endpoints, and error responses as non-indexable at the HTTP-header layer. The SSR itself is technically indexable; JavaScript rendering is not a barrier. |
| Low | The dashboard has only a static title and language declaration. It has no description, canonical, hreflang, Open Graph metadata, or structured data. | `src/web.ts:135-141` | Do not add rich metadata, hreflang, or structured data to a private operational UI. If Welplan's public site is audited separately, validate unique titles/descriptions, absolute canonicals, reciprocal locale alternates, and page-appropriate JSON-LD there. |
| Informational | The dashboard serves no images or image routes, so it has no image-indexing surface. The README image is repository documentation, not dashboard content. | `src/web.ts:135-141`; `README.md:4` | No dashboard image sitemap or image metadata is needed. Audit Welplan's rendered `<img>` elements, alt text, crawlable source URLs, social images, and robots/CDN headers in the actual website repository. |
| Informational | There are no application redirects, rewrites, preferred-host rules, HTTPS enforcement, or trailing-slash normalization in this repository. | `src/web.ts:149-173`; no proxy/platform routing configuration present | Keep the dashboard private. In the Welplan deployment, separately verify one canonical HTTPS host, single-hop redirects, slash consistency, retired-route mappings, and that redirects never target blocked or `noindex` URLs. |

## Welplan follow-up

A complete Welplan audit requires its actual repository and production URL in the authorized worktree. Inspect these items there:

1. Compare production `robots.txt` and every sitemap URL against canonical, indexable 200 pages; exclude redirects, errors, parameter pages, and `noindex` URLs.
2. Crawl representative static, dynamic, paginated, filtered, localized, and error routes while comparing raw HTML with rendered HTML.
3. Validate absolute self-canonicals, reciprocal `hreflang` clusters (including `x-default` where appropriate), unique metadata, and redirect normalization.
4. Validate JSON-LD against visible page content and Google's supported schema types; avoid site-wide irrelevant markup.
5. Confirm images return indexable 200 responses, use descriptive alt text and stable URLs, and are not blocked by robots rules, CDN headers, lazy-loading implementations, or signed URLs.
