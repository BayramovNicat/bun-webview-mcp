#!/usr/bin/env bun
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { AnySchema } from '@modelcontextprotocol/sdk/server/zod-compat.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { z } from 'zod';
import { clearCookiesInView, getCookiesFromView, setCookiesInView } from './auth.ts';
import { captureFromView, screenshotPageOneShot } from './capture.ts';
import {
  formatElementsList,
  formatScreenshotResponse,
  formatTextResponse,
  formatToolError,
} from './formatters.ts';
import { getInteractiveElements } from './page-scripts.ts';
import {
  BrowserActSchema,
  BrowserConsoleSchema,
  BrowserCookiesSchema,
  BrowserElementsSchema,
  BrowserOpenSchema,
  BrowserScreenshotSchema,
  ScreenshotPageSchema,
} from './schemas.ts';
import { BrowserSessionManager } from './session.ts';

const sessionManager = new BrowserSessionManager();

/**
 * Type-safe wrapper around McpServer.registerTool that centralizes error handling,
 * optional session mutex serialization, and avoids TypeScript's exponential
 * ZodRawShapeCompat check in @modelcontextprotocol/sdk.
 */
function defineTool<S extends z.ZodTypeAny>(
  server: McpServer,
  name: string,
  config: {
    title: string;
    description: string;
    inputSchema: S;
    lockSession?: boolean;
  },
  handler: (args: z.infer<S>) => Promise<CallToolResult>,
): void {
  server.registerTool<AnySchema, AnySchema>(
    name,
    {
      title: config.title,
      description: config.description,
      inputSchema: config.inputSchema as unknown as AnySchema,
    },
    (async (args: unknown) => {
      try {
        const parsed = args as z.infer<S>;
        return config.lockSession === false
          ? await handler(parsed)
          : await sessionManager.runExclusive(() => handler(parsed));
      } catch (error) {
        return formatToolError(name, error);
      }
    }) as never,
  );
}

export function createServer(): McpServer {
  const server = new McpServer({
    name: 'bun-webview-mcp',
    version: '1.2.0',
  });

  defineTool(
    server,
    'screenshot_page',
    {
      title: 'Open Page & Take Full-Page Screenshot',
      description:
        'Opens a URL in Bun.WebView headless browser (supporting custom cookies, HTTP headers like Authorization, localStorage, and sessionStorage), scrolls to trigger lazy-loaded content, captures a full-page (or viewport) screenshot, and returns the image directly to the LLM.',
      inputSchema: ScreenshotPageSchema,
      lockSession: false,
    },
    async (args) => {
      const result = await screenshotPageOneShot(args);
      return formatScreenshotResponse(result);
    },
  );

  defineTool(
    server,
    'browser_open',
    {
      title: 'Open URL in Persistent Browser Session',
      description:
        'Opens a URL in a persistent Bun.WebView session (supporting custom cookies, HTTP headers, localStorage, sessionStorage, and profileDirectory) and returns a screenshot to the LLM.',
      inputSchema: BrowserOpenSchema,
    },
    async (args) => {
      const { view, backend } = sessionManager.getOrCreateView(args);
      const result = await captureFromView(view, backend, args, true);
      return formatScreenshotResponse(result);
    },
  );

  defineTool(
    server,
    'browser_act',
    {
      title: 'Interact with Active Browser Session',
      description:
        'Performs full native browser interactions (click, double/right click, type, paste/fill input, clear input, press key/chord, select dropdown option, hover, focus, scroll, scrollTo, wait, evaluate JS, navigate, reload, goBack, goForward, resize) on the active Bun.WebView session and returns an updated screenshot.',
      inputSchema: BrowserActSchema,
    },
    async (args) => {
      const actionNote = await sessionManager.executeAction(args);
      const { view, backend, width, height } = sessionManager.getActiveView();

      if (args.takeScreenshot) {
        const result = await captureFromView(
          view,
          backend,
          {
            width,
            height,
            fullPage: args.fullPage ?? true,
            format: args.format ?? 'jpeg',
            quality: args.quality ?? 80,
            includeText: args.includeText ?? false,
            includeElements: args.includeElements ?? false,
            scrollForLazyLoad: false,
            waitMs: 150,
          },
          true,
        );
        return formatScreenshotResponse(result, actionNote);
      }

      return formatTextResponse(`${actionNote}\nURL: ${view.url}\nTitle: ${view.title}`);
    },
  );

  defineTool(
    server,
    'browser_cookies',
    {
      title: 'Get, Set, or Clear Browser Cookies',
      description:
        'Reads current cookies, injects new cookies (string or structured objects), or clears all cookies in the active browser session.',
      inputSchema: BrowserCookiesSchema,
    },
    async (args) => {
      const { view, backend } = sessionManager.getActiveView();
      switch (args.action) {
        case 'get': {
          const cookies = await getCookiesFromView(view, backend, args.url);
          return formatTextResponse(
            cookies.length === 0
              ? 'No cookies found.'
              : `Cookies (${cookies.length}):\n${JSON.stringify(cookies, null, 2)}`,
          );
        }
        case 'set': {
          if (!args.cookies) {
            throw new Error("Provide 'cookies' when action is 'set'.");
          }
          const count = await setCookiesInView(view, backend, args.cookies, args.url);
          return formatTextResponse(`Set ${count} cookie(s).`);
        }
        case 'clear': {
          await clearCookiesInView(view, backend);
          return formatTextResponse('Cleared browser cookies.');
        }
      }
    },
  );

  defineTool(
    server,
    'browser_elements',
    {
      title: 'List Interactive DOM Elements',
      description:
        'Lists all visible interactive elements (inputs, buttons, links, selects, textareas, contenteditable) on the active page with their unique CSS selectors, text/placeholders, current values, and bounding box coordinates.',
      inputSchema: BrowserElementsSchema,
    },
    async (args) => {
      const { view } = sessionManager.getActiveView();
      const elements = await getInteractiveElements(view, args.limit);
      return formatTextResponse(
        `URL: ${view.url}\nTitle: ${view.title}\nInteractive Elements (${elements.length}):\n${formatElementsList(elements)}`,
      );
    },
  );

  defineTool(
    server,
    'browser_screenshot',
    {
      title: 'Screenshot Active Browser Session',
      description:
        'Takes a full-page (or viewport) screenshot of the currently open Bun.WebView session and returns the image to the LLM.',
      inputSchema: BrowserScreenshotSchema,
    },
    async (args) => {
      const { view, backend, width, height } = sessionManager.getActiveView();
      const result = await captureFromView(view, backend, { ...args, width, height }, true);
      return formatScreenshotResponse(result);
    },
  );

  defineTool(
    server,
    'browser_console',
    {
      title: 'Read Browser Console Logs',
      description:
        'Returns console.log, console.warn, and console.error messages captured from the active browser session.',
      inputSchema: BrowserConsoleSchema,
      lockSession: false,
    },
    async (args) => {
      const logs = sessionManager.getConsoleLogs(args.clear);
      return formatTextResponse(
        logs.length === 0
          ? 'No console logs captured.'
          : logs.map((l) => `[${l.timestamp}] [${l.type}] ${l.text}`).join('\n'),
      );
    },
  );

  server.registerTool(
    'browser_close',
    {
      title: 'Close Active Browser Session',
      description: 'Closes the active Bun.WebView session and frees browser resources.',
    },
    async () => {
      const closed = sessionManager.close();
      return formatTextResponse(
        closed
          ? 'Active Bun.WebView browser session closed.'
          : 'No active Bun.WebView browser session was open.',
      );
    },
  );

  return server;
}

function registerProcessCleanup(): void {
  const cleanup = () => {
    sessionManager.close();
    try {
      Bun.WebView.closeAll();
    } catch {}
  };
  process.once('SIGINT', () => {
    cleanup();
    process.exit(0);
  });
  process.once('SIGTERM', () => {
    cleanup();
    process.exit(0);
  });
  process.once('exit', cleanup);
}

if (import.meta.main) {
  registerProcessCleanup();
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
