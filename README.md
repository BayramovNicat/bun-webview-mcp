# bun-webview-mcp

A headless browser automation and visual inspection **Model Context Protocol (MCP)** server powered by Bun's native [`Bun.WebView`](https://bun.com/docs/runtime/webview) API.

`bun-webview-mcp` enables AI agents and MCP clients (Antigravity, Claude Desktop, Cursor, etc.) to render live web pages, capture true full-page screenshots directly as multimodal MCP `image` blocks, authenticate with cookies/headers/storage, discover interactive DOM elements, and perform real OS-level browser interactions (`isTrusted: true`).

---

## Key Features

- **Native Dual-Backend Engine**
  - **`webkit` (default on macOS)**: Uses macOS's built-in `WKWebView` with zero external browser dependencies and ultra-low memory overhead (~25 MB).
  - **`chrome` (CDP)**: Uses Chrome/Edge via Chrome DevTools Protocol when explicitly selected or automatically escalated when custom HTTP request headers (`Authorization`, etc.) or `HttpOnly` cookies are supplied.
- **True Full-Page Screenshots (`fullPage: true`)**
  - Automatically scrolls the page to trigger `IntersectionObserver` and `loading="lazy"` images, waits for webfonts and image decoding to settle, stabilizes `100vh` hero sections so resizing to full document height doesn't stretch layouts, and returns the rendered image (`webp`, `png`, or `jpeg`) directly to the LLM.
- **Native OS-Level Input (`isTrusted: true`)**
  - Dispatches genuine native mouse clicks, key combinations, scroll wheel gestures, and fast native text insertion (`paste`), plus React/Vue-compatible controlled input filling and `<select>` option selection.
- **First-Class Authentication Support**
  - Pass raw `"Cookie"` header strings, structured cookie arrays, custom HTTP headers (`Authorization: Bearer ...`), `localStorage` entries, and `sessionStorage` entries directly into `screenshot_page` or `browser_open`, or manage cookies mid-session with `browser_cookies`.
- **Concurrency-Safe Persistent Sessions**
  - Serializes all stateful session operations through an internal mutex queue so rapid or parallel tool calls never race on the underlying `Bun.WebView` instance.

---

## Requirements & Installation

- **[Bun](https://bun.com) `>= 1.3.12`** (tested on `v1.4.2+` with native `Bun.WebView` support)
- **macOS** (for zero-dependency native `webkit` backend) or **Chrome / Chromium / Edge** (for `chrome` CDP backend)

```bash
# Install dependencies
bun install

# Start the MCP server over stdio
bun start
```

---

## MCP Client Configuration

### Antigravity / Claude Desktop / Cursor

Add `bun-webview` to your MCP configuration file (for example, `~/.gemini/antigravity/mcp_config.json` in Antigravity or `claude_desktop_config.json` in Claude Desktop):

```json
{
  "mcpServers": {
    "bun-webview": {
      "command": "/Users/your-username/.bun/bin/bun",
      "args": ["run", "/absolute/path/to/bun-webview-mcp/src/index.ts"]
    }
  }
}
```

> **Tip**: Run `which bun` in your terminal to get the exact absolute path to your `bun` binary.

### Optional: Install the Agent Skill (`SKILL.md`)

A ready-to-use skill definition is included in [`skills/bun-webview/SKILL.md`](./skills/bun-webview/SKILL.md) so AI agents immediately know when to activate `bun-webview` and how to invoke its lazy-loaded tools without reading individual JSON schema files first:

```bash
mkdir -p ~/.gemini/config/skills/bun-webview
cp skills/bun-webview/SKILL.md ~/.gemini/config/skills/bun-webview/SKILL.md
```

### Example Prompts to Try

- *"Use `bun-webview` `screenshot_page` to open `https://bun.com` and describe the full page layout."*
- *"Open `https://news.ycombinator.com` with `browser_open`, list the top stories, and click on the first discussion link."*
- *"Open `https://httpbin.org/forms/post`, fill out the customer name, size, and toppings using `browser_act`, and show me a screenshot before submitting."*

---

## Tools Reference

`bun-webview-mcp` exposes **8 MCP tools**:

| Tool | Type | Description |
| :--- | :--- | :--- |
| [`screenshot_page`](#1-screenshot_page) | Stateless | Opens an isolated WebView, navigates to a URL, captures a full-page or viewport screenshot, and closes immediately. |
| [`browser_open`](#2-browser_open) | Stateful | Opens or navigates the persistent interactive browser session with optional auth state and auto-screenshot. |
| [`browser_act`](#3-browser_act) | Stateful | Performs interactions (`click`, `paste`, `type`, `fill`, `select`, `press`, `scroll`, `wait`, `evaluate`, etc.) on the active page. |
| [`browser_cookies`](#4-browser_cookies) | Stateful | Reads (`get`), injects (`set`), or wipes (`clear`) cookies in the active browser session. |
| [`browser_elements`](#5-browser_elements) | Stateful | Lists visible interactive DOM elements (`a`, `button`, `input`, `select`, etc.) with selectors and coordinates. |
| [`browser_screenshot`](#6-browser_screenshot) | Stateful | Captures a fresh full-page or viewport screenshot of the active session at any point. |
| [`browser_console`](#7-browser_console) | Stateful | Returns captured `console.log`, `warn`, and `error` messages from the active page. |
| [`browser_close`](#8-browser_close) | Stateful | Closes the persistent `Bun.WebView` session and frees resources. |

---

### 1. `screenshot_page`

Stateless one-shot tool that creates an ephemeral `Bun.WebView`, navigates to `url`, captures a screenshot, and closes the WebView. Does not affect any active `browser_open` session.

| Parameter | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `url` | `string` | **Required** | Target URL to open (`http://`, `https://`, or `data:`). |
| `width` | `number` | `1280` | Viewport width in pixels (`320`–`3840`). |
| `height` | `number` | `800` | Initial viewport height in pixels (`240`–`2160`). |
| `fullPage` | `boolean` | `true` | Capture the entire scrollable page (`true`) or only the visible viewport (`false`). |
| `maxFullPageHeight` | `number` | `16384` | Maximum full-page capture height in pixels (`240`–`32768`). |
| `scrollForLazyLoad` | `boolean` | `true` | Scroll down the page before capture to trigger lazy-loaded images and observers. |
| `waitForSelector` | `string` | — | Optional CSS selector to wait for before taking the screenshot. |
| `waitMs` | `number` | `500` | Additional settle delay (ms) after navigation (`0`–`30000`). |
| `timeout` | `number` | `30000` | Navigation/action timeout in milliseconds (`1000`–`120000`). |
| `format` | `"webp" \| "png" \| "jpeg"` | `"webp"` | Output image format (`webp` is smallest and fastest for LLMs). |
| `quality` | `number` | `80` | Image compression quality (`0`–`100`) for `jpeg`/`webp`. |
| `includeText` | `boolean` | `false` | Also include extracted `document.body.innerText` (up to 15,000 chars). |
| `includeElements` | `boolean` | `false` | Also include a list of visible interactive DOM elements and selectors. |
| `backend` | `"webkit" \| "chrome"` | `"webkit"` | Browser backend (`webkit` uses native macOS `WKWebView`; `chrome` uses CDP). |
| `cookieString` | `string` | — | Raw Cookie string (e.g. `"session_id=xyz; theme=dark"`). |
| `cookies` | `CookieItem[]` | — | Structured cookie objects (`name`, `value`, `domain`, `path`, `secure`, `httpOnly`, `sameSite`, `expires`). |
| `headers` | `Record<string, string>` | — | Custom HTTP request headers (e.g. `{"Authorization": "Bearer ..."}`). |
| `localStorage` | `Record<string, string>` | — | Key-value pairs to populate in `window.localStorage` for the target origin. |
| `sessionStorage` | `Record<string, string>` | — | Key-value pairs to populate in `window.sessionStorage` for the target origin. |

---

### 2. `browser_open`

Opens or navigates the persistent interactive `Bun.WebView` session. Accepts all the same parameters as `screenshot_page` (with `includeElements` defaulting to `true` so the agent immediately sees clickable selectors).

---

### 3. `browser_act`

Executes an interaction on the currently open page and optionally returns an updated screenshot and interactive element list.

#### Supported `action` Values

| Action | Required Fields | Optional Fields | Description |
| :--- | :--- | :--- | :--- |
| `"click"` | `selector` *or* (`x`, `y`) | `button`, `clickCount`, `modifiers` | Native mouse click on an element (auto-scrolled into view) or at `(x, y)` coordinates. |
| `"paste"` / `"fill"` | `text` | `selector` | Fast native text insertion (`webview.paste`). Clears existing input value first; falls back to React/Vue-compatible setter if needed. |
| `"type"` | `text` | `selector` | Types text into the target element or currently focused element (`webview.type`). |
| `"clear"` | — | `selector` | Clears the value of an `<input>`, `<textarea>`, or `contenteditable` element. |
| `"select"` | `selector` | `value`, `values` | Selects option(s) in a `<select>` dropdown by option `value` or visible label text. |
| `"press"` | `key` | `modifiers` | Presses a special key (`Enter`, `Tab`, `Escape`, `Backspace`, `ArrowDown`, `Space`, etc.). |
| `"hover"` | `selector` | — | Scrolls element into view and dispatches mouse hover events (`mouseenter`, `mouseover`, `mousemove`). |
| `"focus"` | `selector` | — | Scrolls element into view and focuses it. |
| `"scroll"` | — | `deltaX`, `deltaY`, `selector` | Scrolls the page (or `selector` element first) by `(deltaX, deltaY)` pixels (default `deltaY: 600`). |
| `"scrollIntoView"` | `selector` | — | Smoothly scrolls the matching element into the center of the viewport. |
| `"waitForSelector"`| `selector` | `timeout` | Polls until `selector` appears in the DOM or `timeout` elapses. |
| `"waitForText"` | `text` | `timeout` | Polls until `text` appears in `document.body.innerText` or `timeout` elapses. |
| `"wait"` | — | `waitMs` | Waits for a fixed duration in milliseconds (default `1000` ms). |
| `"evaluate"` | `script` | — | Evaluates arbitrary JavaScript inside the page and returns the serialized result. |
| `"reload"` | — | — | Reloads the current page. |
| `"back"` | — | — | Navigates back in session history. |
| `"forward"` | — | — | Navigates forward in session history. |

#### Post-Action Capture Options on `browser_act`

- `screenshot` (`boolean`, default `true`): Capture and return an updated screenshot after the action completes.
- `fullPage` (`boolean`, default `false`): Whether the post-action screenshot should capture the full scrollable page or the current viewport.
- `includeElements` (`boolean`, default `true`): Include refreshed interactive elements after the action.
- `includeText` (`boolean`, default `false`): Include refreshed visible page text after the action.
- `waitMs` (`number`, default `300`): Settle delay in milliseconds after performing the action before capturing.

---

### 4. `browser_cookies`

Manage cookies in the active browser session.

| Parameter | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `action` | `"get" \| "set" \| "clear"` | `"get"` | `"get"` lists cookies, `"set"` injects cookies, `"clear"` wipes cookies. |
| `cookieString` | `string` | — | Raw Cookie string to inject when `action="set"`. |
| `cookies` | `CookieItem[]` | — | Structured cookie objects to inject when `action="set"`. |
| `reload` | `boolean` | `false` | Reload the current page after setting or clearing cookies. |

---

### 5. `browser_elements`

Lists visible interactive DOM elements (`a`, `button`, `input`, `textarea`, `select`, `[role=button]`, etc.) with unique CSS selectors and viewport coordinates.

| Parameter | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `limit` | `number` | `75` | Maximum number of interactive elements to return (`1`–`300`). |

---

### 6. `browser_screenshot`

Captures a fresh viewport or full-page screenshot from the active session without navigating. Supports `fullPage`, `maxFullPageHeight`, `scrollForLazyLoad`, `format`, `quality`, `includeText`, and `includeElements`.

---

### 7. `browser_console`

Reads or clears `console.log`, `console.warn`, and `console.error` output captured from the active page.

| Parameter | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `clear` | `boolean` | `false` | Clear the console log buffer after reading. |

---

### 8. `browser_close`

Closes the persistent `Bun.WebView` session and releases its subprocess/memory.

---

## Usage Recipes

### 1. One-Shot Full-Page Screenshot

```json
{
  "name": "screenshot_page",
  "arguments": {
    "url": "https://bun.com",
    "width": 1280,
    "fullPage": true,
    "format": "webp"
  }
}
```

### 2. Authenticated Page Capture (Cookies + Headers + `localStorage`)

When `headers` (other than `Cookie`) or `httpOnly` cookies are provided, `bun-webview-mcp` automatically uses the `chrome` (CDP) backend if needed so headers are sent on the initial HTTP request.

```json
{
  "name": "browser_open",
  "arguments": {
    "url": "https://app.example.com/dashboard",
    "cookieString": "session_id=s3cr3t_token; theme=dark",
    "headers": {
      "Authorization": "Bearer eyJhbGciOiJIUzI1NiIs..."
    },
    "localStorage": {
      "onboarding_dismissed": "true"
    },
    "fullPage": true
  }
}
```

### 3. Multi-Step Form Interaction

```json
// Step 1: Open the form page
{
  "name": "browser_open",
  "arguments": {
    "url": "https://httpbin.org/forms/post"
  }
}

// Step 2: Fill an input field using native paste
{
  "name": "browser_act",
  "arguments": {
    "action": "paste",
    "selector": "input[name=\"custname\"]",
    "text": "Ada Lovelace"
  }
}

// Step 3: Click the submit button and wait for response
{
  "name": "browser_act",
  "arguments": {
    "action": "click",
    "selector": "button",
    "waitMs": 500
  }
}
```

---

## Architecture & Project Structure

```text
src/
├── index.ts         # MCP server entrypoint & tool registrations (defineTool wrapper)
├── schemas.ts       # Composable Zod schemas & inferred TypeScript types
├── session.ts       # BrowserSessionManager with mutex queue & 17 browser actions
├── capture.ts       # Full-page & viewport screenshot pipeline (WebKit + Chrome CDP)
├── auth.ts          # Cookie parsing, header handling, storage injection & backend selection
├── page-scripts.ts  # In-page DOM helpers, lazy scroll & 100vh layout stabilization
└── formatters.ts    # MCP text/image content block & error formatters
test/
└── mcp.test.ts      # Unit tests & end-to-end WebView integration tests
```

### Development Commands

```bash
# Run unit & end-to-end integration tests
bun test

# Run TypeScript typechecking
bun x tsc --noEmit

# Format & lint code with Biome
bun run format
```
