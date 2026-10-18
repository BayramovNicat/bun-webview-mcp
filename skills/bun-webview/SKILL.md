---
name: bun-webview
description: >-
  Headless browser automation, visual page inspection, and full-page screenshot capture via the
  `bun-webview` MCP server (`Bun.WebView`). Activate this skill whenever the user wants to open a
  URL or localhost dev server, capture a full-page or viewport screenshot, visually inspect UI/layout,
  authenticate with cookies/headers/localStorage, or interact with web pages (click, fill forms,
  select options, scroll, evaluate JS, check console logs).
---

# `bun-webview` MCP Browser & Screenshot Guide

Use the **`bun-webview`** MCP server via `call_mcp_tool` (`ServerName: "bun-webview"`).
Because this skill contains the exact tool signatures below, **you can call `call_mcp_tool` directly without reading `/Users/nicat/.gemini/antigravity/mcp/bun-webview/*.json` first.**

---

## Decision Guide: Which Tool to Call?

1. **One-shot visual inspection / full-page screenshot (stateless)**
   - Call **`screenshot_page`**. It opens an isolated WebView, scrolls to trigger lazy images, stabilizes `100vh` elements, returns the rendered image directly to you, and closes automatically.
2. **Multi-step interaction (clicking, form filling, login, SPA navigation, console debugging)**
   - Step 1: Call **`browser_open`** (returns initial screenshot + interactive DOM elements with selectors).
   - Step 2: Call **`browser_act`** (`click`, `paste`, `select`, `press`, `scroll`, `evaluate`, etc.).
   - Step 3: Call **`browser_close`** when finished to free the WebView process.

---

## Tool Signatures (`ServerName: "bun-webview"`)

### 1. `screenshot_page` (Stateless One-Shot Capture)

```json
{
  "url": "https://example.com",
  "width": 1280,
  "height": 800,
  "fullPage": true,
  "scrollForLazyLoad": true,
  "waitForSelector": "#app-loaded",
  "waitMs": 500,
  "format": "webp",
  "quality": 80,
  "includeText": false,
  "includeElements": false,
  "backend": "webkit",
  "cookieString": "session_id=abc; theme=dark",
  "headers": { "Authorization": "Bearer <token>" },
  "localStorage": { "key": "value" },
  "sessionStorage": { "key": "value" }
}
```
- Only `url` is required. All other fields are optional.

---

### 2. `browser_open` (Start / Navigate Persistent Session)

Accepts the exact same arguments as `screenshot_page` (`url` required; `includeElements` defaults to `true`, `fullPage` defaults to `true`).

---

### 3. `browser_act` (Interact with Active Session)

```json
{
  "action": "click",
  "selector": "button[type=\"submit\"]",
  "screenshot": true,
  "fullPage": false,
  "includeElements": true,
  "waitMs": 300
}
```

#### Supported `action` values & parameters:
- **`"click"`**: `selector` (CSS selector) OR `x` + `y` (viewport coords). Optional: `button` (`"left"|"right"|"middle"`), `clickCount`, `modifiers`.
- **`"paste"`** *(preferred for filling inputs)* or **`"fill"`**: `selector` (optional if already focused), `text` (required). Clears existing value and inserts text natively.
- **`"type"`**: `selector` (optional), `text` (required).
- **`"clear"`**: `selector` (optional). Clears `<input>`, `<textarea>`, or `contenteditable`.
- **`"select"`**: `selector` (required `<select>`), plus `value` (`string`) or `values` (`string[]`). Matches option `value` or visible label.
- **`"press"`**: `key` (required: `"Enter"`, `"Tab"`, `"Escape"`, `"Backspace"`, `"Delete"`, `"Space"`, `"ArrowDown"`, `"ArrowUp"`, `"ArrowLeft"`, `"ArrowRight"`, or single char), optional `modifiers` (`["Shift"|"Control"|"Alt"|"Meta"]`).
- **`"hover"`** / **`"focus"`** / **`"scrollIntoView"`**: `selector` (required).
- **`"scroll"`**: `deltaX` (default `0`), `deltaY` (default `600`), optional `selector`.
- **`"waitForSelector"`**: `selector` (required), optional `timeout` (ms).
- **`"waitForText"`**: `text` (required), optional `timeout` (ms).
- **`"wait"`**: `waitMs` (default `1000`).
- **`"evaluate"`**: `script` (required JS expression; e.g. `"document.title"` or `"(() => ({ url: location.href }))()"`).
- **`"reload"`** / **`"back"`** / **`"forward"`**: No extra parameters required.

---

### 4. `browser_cookies` (Manage Session Cookies)

```json
{
  "action": "get",
  "cookieString": "session_id=xyz; role=admin",
  "cookies": [{ "name": "token", "value": "123", "path": "/" }],
  "reload": true
}
```
- `action`: `"get"` (default), `"set"`, or `"clear"`.

---

### 5. `browser_elements` (List Interactive Selectors)

```json
{ "limit": 75 }
```

---

### 6. `browser_screenshot` (Capture Current Session State)

```json
{
  "fullPage": true,
  "format": "webp",
  "includeText": false,
  "includeElements": false
}
```

---

### 7. `browser_console` (Read Page Console Logs)

```json
{ "clear": false }
```

---

### 8. `browser_close` (Close Persistent Session)

```json
{}
```

---

## Best Practices

- **Prefer `"paste"` over `"type"`** when filling form inputs—it is faster and handles multi-character strings and controlled React/Vue inputs cleanly.
- **Authenticated pages**: Pass `cookieString`, `headers`, or `localStorage` directly in `screenshot_page` or `browser_open`. When custom HTTP headers (other than `Cookie`) or `httpOnly` cookies are passed, `bun-webview` automatically switches to the `chrome` (CDP) backend if needed.
- **Clean up**: Always call `browser_close` after completing a stateful `browser_open` workflow.
