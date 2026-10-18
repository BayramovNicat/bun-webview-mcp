import { z } from 'zod';

export const BackendSchema = z.enum(['webkit', 'chrome']);
export const ImageFormatSchema = z.enum(['jpeg', 'png', 'webp']);
export const ModifierSchema = z.enum(['Shift', 'Control', 'Alt', 'Meta']);
export const MouseButtonSchema = z.enum(['left', 'right', 'middle']);
export const ScrollBlockSchema = z.enum(['start', 'center', 'end', 'nearest']);
export const CookieSameSiteSchema = z.enum(['Strict', 'Lax', 'None']);

export type BackendType = z.infer<typeof BackendSchema>;
export type ImageFormat = z.infer<typeof ImageFormatSchema>;
export type KeyModifier = z.infer<typeof ModifierSchema>;

export const CookieItemSchema = z.object({
  name: z.string().describe('Cookie name'),
  value: z.string().describe('Cookie value'),
  url: z.string().optional().describe('Request-URI to associate with the cookie'),
  domain: z.string().optional().describe('Cookie domain (defaults to target URL hostname)'),
  path: z.string().optional().default('/').describe("Cookie path (default: '/')"),
  secure: z.boolean().optional().describe('Whether cookie is marked Secure'),
  httpOnly: z
    .boolean()
    .optional()
    .describe("Whether cookie is HttpOnly (automatically uses 'chrome' backend when true)"),
  sameSite: CookieSameSiteSchema.optional().describe('SameSite policy (Strict, Lax, None)'),
  expires: z.number().optional().describe('Expiration as Unix epoch timestamp in seconds'),
});

export type CookieItem = z.infer<typeof CookieItemSchema>;

export const CookiesInputSchema = z.union([
  z.string().describe("Raw Cookie header string, e.g. 'session_id=abc; theme=dark'"),
  z.array(CookieItemSchema).describe('Array of structured cookie objects'),
]);

export type CookiesInput = z.infer<typeof CookiesInputSchema>;

/**
 * Shared authentication, cookies, custom HTTP headers, and Web Storage options.
 */
export const SharedAuthSchema = z.object({
  cookies: CookiesInputSchema.optional().describe(
    "Cookies to set before loading the page (either a 'k=v; k2=v2' string or an array of cookie objects)",
  ),
  headers: z
    .record(z.string(), z.string())
    .optional()
    .describe(
      "Custom HTTP request headers (e.g. { Authorization: 'Bearer ...', Cookie: '...' }). Automatically uses 'chrome' backend unless 'webkit' is explicitly set.",
    ),
  localStorage: z
    .record(z.string(), z.string())
    .optional()
    .describe('Key-value pairs to pre-populate in window.localStorage for the target origin'),
  sessionStorage: z
    .record(z.string(), z.string())
    .optional()
    .describe('Key-value pairs to pre-populate in window.sessionStorage for the target origin'),
  userAgent: z.string().optional().describe('Custom User-Agent header override'),
});

export type AuthOptions = z.infer<typeof SharedAuthSchema>;

const ViewportWidthField = z
  .number()
  .int()
  .min(1)
  .max(16384)
  .optional()
  .default(1280)
  .describe('Viewport width in CSS pixels (default: 1280)');

const ViewportHeightField = z
  .number()
  .int()
  .min(1)
  .max(16384)
  .optional()
  .default(800)
  .describe('Initial viewport height in CSS pixels (default: 800)');

const MaxHeightField = z
  .number()
  .int()
  .min(1)
  .max(16384)
  .optional()
  .default(12000)
  .describe('Maximum full-page capture height in CSS pixels (default: 12000, max: 16384)');

/**
 * Shared image encoding and content extraction fields reused across screenshot tools.
 */
export const SharedCaptureOutputSchema = z.object({
  fullPage: z
    .boolean()
    .optional()
    .default(true)
    .describe(
      'Capture the full scrollable page height (default: true). Set false for viewport only.',
    ),
  format: ImageFormatSchema.optional()
    .default('jpeg')
    .describe("Image format: 'jpeg' (default, compact for LLMs), 'png' (lossless), or 'webp'"),
  quality: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .default(80)
    .describe('Compression quality 1-100 for jpeg/webp (default: 80)'),
  includeText: z
    .boolean()
    .optional()
    .default(false)
    .describe('Also return visible text content from the page alongside the screenshot'),
  includeElements: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      'Also return interactive DOM elements (inputs, buttons, links, selects) with unique CSS selectors and coordinates',
    ),
  savePath: z
    .string()
    .optional()
    .describe('Optional file path on disk to also save the screenshot image'),
});

/**
 * Shared timing and wait fields reused across navigation and capture tools.
 */
export const SharedTimingSchema = z.object({
  waitForSelector: z
    .string()
    .optional()
    .describe('Optional CSS selector to wait for before capturing'),
  waitTimeoutMs: z
    .number()
    .int()
    .min(100)
    .max(120000)
    .optional()
    .default(15000)
    .describe('Max milliseconds to wait for waitForSelector (default: 15000)'),
  waitMs: z
    .number()
    .int()
    .min(0)
    .max(60000)
    .optional()
    .default(300)
    .describe('Additional settle time in milliseconds before capturing (default: 300)'),
});

export const ScreenshotPageSchema = SharedCaptureOutputSchema.merge(SharedTimingSchema)
  .merge(SharedAuthSchema)
  .extend({
    url: z
      .string()
      .describe('The URL to open (e.g. https://example.com, file:///..., or data:text/html,...)'),
    width: ViewportWidthField,
    height: ViewportHeightField,
    maxHeight: MaxHeightField,
    backend: BackendSchema.optional().describe(
      "Browser engine: 'webkit' (default on macOS, zero dependencies) or 'chrome' (auto-selected when custom HTTP headers or HttpOnly cookies are provided)",
    ),
    scrollForLazyLoad: z
      .boolean()
      .optional()
      .default(true)
      .describe(
        'Scroll down the page before capture to trigger lazy-loaded images/sections (default: true)',
      ),
  });

export const BrowserOpenSchema = SharedCaptureOutputSchema.merge(SharedTimingSchema)
  .merge(SharedAuthSchema)
  .extend({
    url: z.string().describe('The URL to navigate to'),
    width: ViewportWidthField,
    height: ViewportHeightField,
    maxHeight: MaxHeightField,
    backend: BackendSchema.optional(),
    profileDirectory: z
      .string()
      .optional()
      .describe(
        'Optional directory path to persist cookies, localStorage, and session state across runs',
      ),
    scrollForLazyLoad: z.boolean().optional().default(true),
  });

export const BrowserScreenshotSchema = SharedCaptureOutputSchema.merge(SharedTimingSchema).extend({
  maxHeight: MaxHeightField,
  waitMs: z.number().int().min(0).max(60000).optional().default(100),
  scrollForLazyLoad: z.boolean().optional().default(false),
});

export const BrowserActSchema = SharedCaptureOutputSchema.omit({
  savePath: true,
}).extend({
  action: z
    .enum([
      'click',
      'type',
      'paste',
      'fill',
      'clear',
      'press',
      'select',
      'hover',
      'focus',
      'scroll',
      'scrollTo',
      'wait',
      'evaluate',
      'navigate',
      'reload',
      'goBack',
      'goForward',
      'resize',
    ])
    .describe(
      "Action to execute: 'click', 'type', 'paste'/'fill' (clear then insert text), 'clear', 'press', 'select', 'hover', 'focus', 'scroll', 'scrollTo', 'wait', 'evaluate', 'navigate', 'reload', 'goBack', 'goForward', 'resize'",
    ),
  selector: z
    .string()
    .optional()
    .describe(
      'CSS selector for click, type, paste, fill, clear, press, select, hover, focus, scrollTo, or wait',
    ),
  x: z.number().optional().describe("X coordinate for 'click' or horizontal deltaX for 'scroll'"),
  y: z.number().optional().describe("Y coordinate for 'click' or vertical deltaY for 'scroll'"),
  button: MouseButtonSchema.optional()
    .default('left')
    .describe("Mouse button for 'click' (default: 'left')"),
  clickCount: z
    .number()
    .int()
    .min(1)
    .max(3)
    .optional()
    .default(1)
    .describe('Click count: 1 (single), 2 (double-click), 3 (triple-click)'),
  modifiers: z
    .array(ModifierSchema)
    .optional()
    .describe("Held modifier keys for 'click' or 'press'"),
  text: z
    .string()
    .optional()
    .describe("Text to insert/paste for 'type', 'paste', 'fill', or text to wait for in 'wait'"),
  clear: z
    .boolean()
    .optional()
    .describe(
      "For 'type': clear existing input value before inserting text (always true for 'paste' and 'fill')",
    ),
  submit: z
    .boolean()
    .optional()
    .default(false)
    .describe("For 'type', 'paste', or 'fill': press Enter automatically after inserting text"),
  key: z
    .string()
    .optional()
    .describe(
      "Key name for 'press' (Enter, Tab, Space, Backspace, Delete, Escape, ArrowUp, ArrowDown, etc., or single char with modifiers)",
    ),
  value: z.string().optional().describe("Option value attribute to choose for 'select' action"),
  label: z.string().optional().describe("Option visible label text to choose for 'select' action"),
  optionIndex: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Zero-based option index to choose for 'select' action"),
  block: ScrollBlockSchema.optional()
    .default('center')
    .describe("Vertical alignment for 'scrollTo' (default: 'center')"),
  url: z.string().optional().describe("URL for 'navigate' action"),
  script: z
    .string()
    .optional()
    .describe("JavaScript expression to evaluate in the page for 'evaluate'"),
  width: z.number().int().min(1).max(16384).optional().describe("New width for 'resize'"),
  height: z.number().int().min(1).max(16384).optional().describe("New height for 'resize'"),
  timeoutMs: z
    .number()
    .int()
    .min(100)
    .max(120000)
    .optional()
    .default(15000)
    .describe("Timeout in milliseconds for selector actionability or 'wait'"),
  waitMs: z
    .number()
    .int()
    .min(0)
    .max(60000)
    .optional()
    .describe("Duration to sleep in ms for 'wait' action"),
  takeScreenshot: z
    .boolean()
    .optional()
    .default(true)
    .describe('Capture and return a screenshot after performing the action (default: true)'),
});

export const BrowserCookiesSchema = z.object({
  action: z
    .enum(['get', 'set', 'clear'])
    .describe(
      "Cookie operation: 'get' (read current cookies), 'set' (inject cookies), or 'clear' (delete all cookies)",
    ),
  cookies: CookiesInputSchema.optional().describe("Cookies to set when action is 'set'"),
  url: z
    .string()
    .optional()
    .describe('Optional URL scope when setting or getting cookies (defaults to active page URL)'),
});

export const BrowserElementsSchema = z.object({
  limit: z
    .number()
    .int()
    .min(1)
    .max(500)
    .optional()
    .default(150)
    .describe('Maximum number of interactive elements to return (default: 150)'),
});

export const BrowserConsoleSchema = z.object({
  clear: z
    .boolean()
    .optional()
    .default(false)
    .describe('Clear buffered console logs after reading'),
});

export const BrowserCloseSchema = z.object({});

export type ScreenshotPageArgs = z.infer<typeof ScreenshotPageSchema>;
export type BrowserOpenArgs = z.infer<typeof BrowserOpenSchema>;
export type BrowserScreenshotArgs = z.infer<typeof BrowserScreenshotSchema>;
export type BrowserActArgs = z.infer<typeof BrowserActSchema>;
export type BrowserCookiesArgs = z.infer<typeof BrowserCookiesSchema>;
export type BrowserElementsArgs = z.infer<typeof BrowserElementsSchema>;
export type BrowserConsoleArgs = z.infer<typeof BrowserConsoleSchema>;

export interface CapturePageOptions extends AuthOptions {
  url?: string;
  width?: number;
  height?: number;
  fullPage?: boolean;
  maxHeight?: number;
  format?: ImageFormat;
  quality?: number;
  backend?: BackendType;
  waitForSelector?: string;
  waitTimeoutMs?: number;
  waitMs?: number;
  scrollForLazyLoad?: boolean;
  includeText?: boolean;
  includeElements?: boolean;
  savePath?: string;
}

export interface InteractiveElementInfo {
  index: number;
  tag: string;
  type?: string;
  role?: string;
  selector: string;
  text: string;
  placeholder?: string;
  value?: string;
  href?: string;
  checked?: boolean;
  disabled?: boolean;
  rect: { x: number; y: number; width: number; height: number };
}

export interface CapturePageResult {
  url: string;
  title: string;
  backend: BackendType;
  format: ImageFormat;
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp';
  base64: string;
  byteLength: number;
  viewport: { width: number; height: number };
  capturedSize: { width: number; height: number };
  fullPage: boolean;
  savedTo?: string;
  textContent?: string;
  elements?: InteractiveElementInfo[];
}
