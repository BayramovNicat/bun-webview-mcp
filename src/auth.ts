import { evalInPage } from './page-scripts.ts';
import type { AuthOptions, BackendType, CookieItem, CookiesInput } from './schemas.ts';

/**
 * Parses a raw Cookie header string ("key1=val1; key2=val2") into structured CookieItem objects.
 */
export function parseCookieString(raw: string): CookieItem[] {
  return raw
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((pair) => {
      const eqIdx = pair.indexOf('=');
      if (eqIdx === -1) {
        return { name: pair, value: '', path: '/' };
      }
      return {
        name: pair.slice(0, eqIdx).trim(),
        value: pair.slice(eqIdx + 1).trim(),
        path: '/',
      };
    })
    .filter((c) => c.name.length > 0);
}

/**
 * Normalizes cookies from `cookies` (string or array) and any `Cookie` header in `headers`.
 */
export function normalizeCookies(
  cookiesInput?: CookiesInput,
  headers?: Record<string, string>,
): CookieItem[] {
  const list: CookieItem[] = [];

  if (typeof cookiesInput === 'string') {
    list.push(...parseCookieString(cookiesInput));
  } else if (Array.isArray(cookiesInput)) {
    list.push(...cookiesInput);
  }

  if (headers) {
    for (const [k, v] of Object.entries(headers)) {
      if (k.toLowerCase() === 'cookie' && v) {
        list.push(...parseCookieString(v));
      }
    }
  }

  return list;
}

/**
 * Returns HTTP headers excluding any `Cookie` header that is already handled via cookie injection,
 * or keeps all headers for CDP `Network.setExtraHTTPHeaders`.
 */
function hasNonCookieHeaders(headers?: Record<string, string>): boolean {
  if (!headers) return false;
  return Object.keys(headers).some((k) => k.toLowerCase() !== 'cookie');
}

/**
 * Automatically selects the 'chrome' backend when custom HTTP headers, User-Agent override,
 * or HttpOnly cookies are requested and no explicit backend was forced.
 */
export function resolveEffectiveBackend(
  options: (AuthOptions & { backend?: BackendType }) | undefined,
  fallbackBackend: BackendType,
): BackendType {
  if (options?.backend) {
    return options.backend;
  }

  const cookies = normalizeCookies(options?.cookies, options?.headers);
  const needsCdp =
    hasNonCookieHeaders(options?.headers) ||
    Boolean(options?.userAgent) ||
    cookies.some((c) => c.httpOnly === true);

  if (needsCdp) {
    return 'chrome';
  }

  return fallbackBackend;
}

function attachTargetUrlToCookies(cookies: CookieItem[], targetUrl: string): CookieItem[] {
  let parsedUrl: URL | null = null;
  try {
    parsedUrl = new URL(targetUrl);
  } catch {}

  const isHttp = parsedUrl?.protocol === 'http:' || parsedUrl?.protocol === 'https:';

  return cookies.map((cookie) => {
    const resolved: CookieItem = {
      ...cookie,
      path: cookie.path || '/',
    };
    if (!resolved.url && !resolved.domain && isHttp && parsedUrl) {
      resolved.url = parsedUrl.origin;
    }
    return resolved;
  });
}

function formatDocumentCookieAssignment(cookie: CookieItem): string {
  const parts = [`${cookie.name}=${cookie.value}`, `path=${cookie.path || '/'}`];
  if (cookie.domain) parts.push(`domain=${cookie.domain}`);
  if (cookie.secure) parts.push('secure');
  if (cookie.sameSite) parts.push(`samesite=${cookie.sameSite}`);
  if (typeof cookie.expires === 'number') {
    parts.push(`expires=${new Date(cookie.expires * 1000).toUTCString()}`);
  }
  return parts.join('; ');
}

/**
 * Navigates to `url` while applying cookies, custom HTTP headers, User-Agent, and localStorage/sessionStorage.
 */
export async function navigateWithAuth(
  view: Bun.WebView,
  backend: BackendType,
  url: string,
  auth?: AuthOptions,
): Promise<void> {
  const cookies = normalizeCookies(auth?.cookies, auth?.headers);
  const hasHeaders = Boolean(auth?.headers && Object.keys(auth.headers).length > 0);
  const hasLocalStorage = Boolean(auth?.localStorage && Object.keys(auth.localStorage).length > 0);
  const hasSessionStorage = Boolean(
    auth?.sessionStorage && Object.keys(auth.sessionStorage).length > 0,
  );
  const hasUserAgent = Boolean(auth?.userAgent);
  const hasAnyAuth =
    cookies.length > 0 || hasHeaders || hasLocalStorage || hasSessionStorage || hasUserAgent;

  if (!hasAnyAuth) {
    await view.navigate(url);
    return;
  }

  if (backend === 'chrome') {
    // Establish CDP session if this view has not navigated yet
    if (!view.url) {
      await view.navigate('about:blank');
    }

    await view.cdp('Network.enable');

    if (hasHeaders && auth?.headers) {
      await view.cdp('Network.setExtraHTTPHeaders', {
        headers: auth.headers,
      });
    }

    if (hasUserAgent && auth?.userAgent) {
      await view.cdp('Emulation.setUserAgentOverride', {
        userAgent: auth.userAgent,
      });
    }

    if (cookies.length > 0) {
      const cdpCookies = attachTargetUrlToCookies(cookies, url);
      await view.cdp('Network.setCookies', { cookies: cdpCookies });
    }

    if (hasLocalStorage || hasSessionStorage) {
      await view.cdp('Page.enable');
      const lsJson = JSON.stringify(auth?.localStorage ?? {});
      const ssJson = JSON.stringify(auth?.sessionStorage ?? {});
      await view.cdp('Page.addScriptToEvaluateOnNewDocument', {
        source: `(() => {
          try {
            const ls = ${lsJson};
            for (const [k, v] of Object.entries(ls)) window.localStorage.setItem(k, v);
            const ss = ${ssJson};
            for (const [k, v] of Object.entries(ss)) window.sessionStorage.setItem(k, v);
          } catch {}
        })()`,
      });
    }

    await view.navigate(url);
    return;
  }

  // WebKit backend: navigate to establish origin, inject document.cookie + storage, and reload
  await view.navigate(url);

  const cookieStrings = cookies.map(formatDocumentCookieAssignment);
  await evalInPage(
    view,
    (payload) => {
      try {
        for (const c of payload.cookieStrings) {
          // biome-ignore lint/suspicious/noDocumentCookie: Required to set cookies in WKWebView page context
          document.cookie = c;
        }
        for (const [k, v] of Object.entries(payload.localStorage)) {
          window.localStorage.setItem(k, v);
        }
        for (const [k, v] of Object.entries(payload.sessionStorage)) {
          window.sessionStorage.setItem(k, v);
        }
      } catch {}
    },
    {
      cookieStrings,
      localStorage: auth?.localStorage ?? {},
      sessionStorage: auth?.sessionStorage ?? {},
    },
  );

  await view.navigate(url);
}

export async function getCookiesFromView(
  view: Bun.WebView,
  backend: BackendType,
  url?: string,
): Promise<
  Array<{ name: string; value: string; domain?: string; path?: string; httpOnly?: boolean }>
> {
  if (backend === 'chrome') {
    await view.cdp('Network.enable');
    const targetUrls = url ? [url] : view.url ? [view.url] : undefined;
    const res = (await view.cdp(
      'Network.getCookies',
      targetUrls ? { urls: targetUrls } : undefined,
    )) as {
      cookies: Array<{
        name: string;
        value: string;
        domain?: string;
        path?: string;
        httpOnly?: boolean;
      }>;
    };
    return res.cookies ?? [];
  }

  const rawCookie = await evalInPage(view, () => document.cookie || '');
  return parseCookieString(rawCookie).map(({ name, value }) => ({ name, value }));
}

export async function setCookiesInView(
  view: Bun.WebView,
  backend: BackendType,
  cookiesInput: CookiesInput,
  url?: string,
): Promise<number> {
  const cookies = normalizeCookies(cookiesInput);
  if (cookies.length === 0) return 0;

  const effectiveUrl = url || view.url;

  if (backend === 'chrome') {
    await view.cdp('Network.enable');
    const cdpCookies = effectiveUrl ? attachTargetUrlToCookies(cookies, effectiveUrl) : cookies;
    await view.cdp('Network.setCookies', { cookies: cdpCookies });
    return cdpCookies.length;
  }

  const cookieStrings = cookies.map(formatDocumentCookieAssignment);
  await evalInPage(
    view,
    (list) => {
      for (const c of list) {
        // biome-ignore lint/suspicious/noDocumentCookie: Required to set cookies in WKWebView page context
        document.cookie = c;
      }
    },
    cookieStrings,
  );
  return cookieStrings.length;
}

export async function clearCookiesInView(view: Bun.WebView, backend: BackendType): Promise<void> {
  if (backend === 'chrome') {
    await view.cdp('Network.enable');
    await view.cdp('Network.clearBrowserCookies');
    return;
  }

  await evalInPage(view, () => {
    const pairs = (document.cookie || '').split(';');
    for (const pair of pairs) {
      const eqIdx = pair.indexOf('=');
      const name = (eqIdx > -1 ? pair.slice(0, eqIdx) : pair).trim();
      if (name) {
        // biome-ignore lint/suspicious/noDocumentCookie: Required to expire cookies in WKWebView page context
        document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
      }
    }
  });
}
