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
 * Returns HTTP headers excluding any `Cookie` header (which is normalized and set via cookies).
 */
export function stripCookieHeader(headers?: Record<string, string>): Record<string, string> {
  if (!headers) return {};
  const filtered: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() !== 'cookie') {
      filtered[k] = v;
    }
  }
  return filtered;
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

  const nonCookieHeaders = stripCookieHeader(options?.headers);
  const cookies = normalizeCookies(options?.cookies, options?.headers);
  const needsCdp =
    Object.keys(nonCookieHeaders).length > 0 ||
    Boolean(options?.userAgent) ||
    cookies.some((c) => c.httpOnly === true);

  return needsCdp ? 'chrome' : fallbackBackend;
}

function attachTargetUrlToCookies(cookies: CookieItem[], targetUrl?: string): CookieItem[] {
  let parsedUrl: URL | null = null;
  if (targetUrl) {
    try {
      parsedUrl = new URL(targetUrl);
    } catch {}
  }

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
 * Shared in-page function to apply document.cookie strings, localStorage, and sessionStorage.
 */
function applyBrowserStateInPage(payload: {
  cookieStrings: string[];
  localStorage: Record<string, string>;
  sessionStorage: Record<string, string>;
}): void {
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
}

async function applyCookiesToView(
  view: Bun.WebView,
  backend: BackendType,
  cookies: CookieItem[],
  targetUrl?: string,
): Promise<number> {
  if (cookies.length === 0) return 0;

  if (backend === 'chrome') {
    await view.cdp('Network.enable');
    const cdpCookies = attachTargetUrlToCookies(cookies, targetUrl || view.url);
    await view.cdp('Network.setCookies', { cookies: cdpCookies });
    return cdpCookies.length;
  }

  const cookieStrings = cookies.map(formatDocumentCookieAssignment);
  await evalInPage(view, applyBrowserStateInPage, {
    cookieStrings,
    localStorage: {},
    sessionStorage: {},
  });
  return cookieStrings.length;
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
  const extraHeaders = stripCookieHeader(auth?.headers);
  const hasExtraHeaders = Object.keys(extraHeaders).length > 0;
  const localStorage = auth?.localStorage ?? {};
  const sessionStorage = auth?.sessionStorage ?? {};
  const hasStorage = Object.keys(localStorage).length > 0 || Object.keys(sessionStorage).length > 0;
  const hasUserAgent = Boolean(auth?.userAgent);
  const hasAnyAuth = cookies.length > 0 || hasExtraHeaders || hasStorage || hasUserAgent;

  if (!hasAnyAuth) {
    await view.navigate(url);
    return;
  }

  if (backend === 'chrome') {
    if (!view.url) {
      await view.navigate('about:blank');
    }

    await view.cdp('Network.enable');

    if (hasExtraHeaders) {
      await view.cdp('Network.setExtraHTTPHeaders', {
        headers: extraHeaders,
      });
    }

    if (hasUserAgent && auth?.userAgent) {
      await view.cdp('Emulation.setUserAgentOverride', {
        userAgent: auth.userAgent,
      });
    }

    if (cookies.length > 0) {
      await applyCookiesToView(view, 'chrome', cookies, url);
    }

    if (hasStorage) {
      await view.cdp('Page.enable');
      const payloadJson = JSON.stringify({
        cookieStrings: [],
        localStorage,
        sessionStorage,
      });
      await view.cdp('Page.addScriptToEvaluateOnNewDocument', {
        source: `(${applyBrowserStateInPage.toString()})(${payloadJson})`,
      });
    }

    await view.navigate(url);
    return;
  }

  // WebKit backend: navigate to establish origin, inject cookies + storage, then navigate again
  await view.navigate(url);
  await evalInPage(view, applyBrowserStateInPage, {
    cookieStrings: cookies.map(formatDocumentCookieAssignment),
    localStorage,
    sessionStorage,
  });
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
  return await applyCookiesToView(view, backend, cookies, url);
}

export async function clearCookiesInView(view: Bun.WebView, backend: BackendType): Promise<void> {
  if (backend === 'chrome') {
    await view.cdp('Network.enable');
    await view.cdp('Network.clearBrowserCookies');
    return;
  }

  const current = await getCookiesFromView(view, 'webkit');
  const expiredStrings = current.map(
    (c) => `${c.name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`,
  );
  if (expiredStrings.length > 0) {
    await evalInPage(view, applyBrowserStateInPage, {
      cookieStrings: expiredStrings,
      localStorage: {},
      sessionStorage: {},
    });
  }
}
