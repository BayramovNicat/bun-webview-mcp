# bun-webview-mcp

An MCP (Model Context Protocol) server built on **`Bun.WebView`** that lets AI agents open web pages in a headless browser, authenticate with **cookies, custom HTTP headers (`Authorization`, `Cookie`, etc.), `localStorage`, and `sessionStorage`**, capture **full-page screenshots** (or viewport screenshots), discover interactive DOM elements, perform full native browser interactions (`click`, `paste`/`fill`, `type`, `select`, `press`, `hover`, `scroll`, `evaluate`), and return the rendered images directly to the LLM.

Zero external browser dependencies on macOS (uses native `WKWebView` via `Bun.WebView`), and supports Chrome/Chromium via CDP (`backend: "chrome"`).

## Requirements

- [Bun](https://bun.com) `v1.4.0+` (which includes native `Bun.WebView`)

## Installation

```bash
bun install
```

## MCP Client Configuration

Add this server to your MCP configuration (e.g., `mcp_config.json`, Claude Desktop, Cursor, or Antigravity):

```json
{
  "mcpServers": {
    "bun-webview": {
      "command": "/Users/nicat/.bun/bin/bun",
      "args": ["run", "/Users/nicat/Documents/antigravity/noble-curie/src/index.ts"]
    }
  }
}
```

## Available Tools

### 1. `screenshot_page` (One-Shot Full-Page Screenshot)
Opens a URL in `Bun.WebView`, applies optional authentication (cookies, HTTP headers, storage), scrolls to trigger lazy-loaded content, stabilizes `100vh` sections so full-page resizing doesn't distort hero layouts, captures the full scrollable page, and returns the image (`image/jpeg`, `image/png`, or `image/webp`) directly to the LLM.

- `url` *(string, required)*: URL to open (`https://...`, `file:///...`, `data:text/html,...`).
- `cookies` *(string | CookieItem[], optional)*: Raw cookie header string (`"session_id=abc; role=admin"`) or structured cookie array (`[{ name, value, domain?, path?, secure?, httpOnly?, sameSite?, expires? }]`).
- `headers` *(Record<string, string>, optional)*: Custom HTTP request headers (e.g. `{ "Authorization": "Bearer ...", "Cookie": "..." }`). Automatically selects the `"chrome"` backend when non-Cookie headers or `httpOnly` cookies are provided.
- `localStorage` / `sessionStorage` *(Record<string, string>, optional)*: Key-value pairs to pre-populate in `window.localStorage` / `window.sessionStorage`.
- `userAgent` *(string, optional)*: Custom `User-Agent` override.
- `fullPage` *(boolean, default: `true`)*: Capture the entire scrollable height (`true`) or viewport only (`false`).
- `width` / `height` / `maxHeight`: Viewport & maximum full-page capture dimensions in CSS pixels.
- `format` *(`"jpeg" | "png" | "webp"`, default: `"jpeg"`)* & `quality` *(1–100, default: `80`)*.
- `includeText` *(boolean, default: `false`)*: Also include visible page text (`document.body.innerText`).
- `includeElements` *(boolean, default: `false`)*: Also return all interactive DOM elements with their unique CSS selectors and coordinates.
- `savePath` *(string, optional)*: Save the captured image to disk.

### 2. `browser_open` (Stateful Session Navigation)
Opens a URL in a persistent `Bun.WebView` session (supporting `cookies`, `headers`, `localStorage`, `sessionStorage`, `userAgent`, and `profileDirectory` to persist state on disk) and returns a full-page or viewport screenshot to the LLM.

### 3. `browser_act` (Full Browser Interaction + Screenshot)
Executes native (`isTrusted: true`) browser actions on the active session and optionally returns an updated full-page screenshot:

- **`click`**: Click by `selector` (waits for element to be visible, stable, and unobstructed) or `(x, y)` coordinates. Supports `button` (`"left" | "right" | "middle"`), `clickCount` (`1` single, `2` double-click, `3` triple-click), and `modifiers` (`["Shift", "Control", "Alt", "Meta"]`).
- **`paste` / `fill`**: Focuses `selector`, **clears any existing value** (compatible with React/Vue controlled inputs and `[contenteditable]`), pastes `text` using the browser's native `InsertText` command (`isTrusted: true`), and optionally presses `Enter` (`submit: true`).
- **`type`**: Focuses `selector` and inserts `text` (set `clear: true` to clear first, or `submit: true` to press `Enter` after).
- **`clear`**: Clears the value of an `<input>`, `<textarea>`, or `[contenteditable]` element.
- **`press`**: Presses a named key (`Enter`, `Tab`, `Space`, `Backspace`, `Delete`, `Escape`, `ArrowDown`, etc.) or keyboard shortcut chord (e.g., `key: "a", modifiers: ["Meta"]`).
- **`select`**: Selects an `<option>` inside a `<select>` dropdown by `value`, visible `label`, or zero-based `optionIndex` and fires `input`/`change` events.
- **`hover`** / **`focus`**: Hovers over or focuses `selector`.
- **`scroll`** / **`scrollTo`**: Scrolls by `(x, y)` pixel delta or scrolls `selector` into view (`block: "start" | "center" | "end" | "nearest"`).
- **`wait`**: Waits for `selector` to become visible, `text` to appear on the page, or `waitMs` milliseconds.
- **`evaluate`**: Runs a JavaScript expression in the page context and returns the serialized result.
- **`navigate` / `reload` / `goBack` / `goForward` / `resize`**: Session navigation and viewport resizing.

### 4. `browser_cookies` (Manage Session Cookies)
Gets, sets, or clears cookies in the active browser session:
- `action`: `"get" | "set" | "clear"`
- `cookies`: Raw `"k=v; k2=v2"` string or array of cookie objects when `action: "set"`.

### 5. `browser_elements` (Discover Clickable & Fillable Elements)
Lists all visible interactive elements (`a`, `button`, `input`, `textarea`, `select`, `[role=button]`, `[contenteditable]`) with their unique CSS selector, label/placeholder, current value, and bounding box `(x, y, width, height)`.

### 6. `browser_screenshot`
Takes a full-page or viewport screenshot of the currently active browser session.

### 7. `browser_console`
Returns captured `console.log`, `console.warn`, and `console.error` messages from the active page.

### 8. `browser_close`
Closes the active persistent `Bun.WebView` session.
