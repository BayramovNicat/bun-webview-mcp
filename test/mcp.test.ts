/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { parseCookieString, resolveEffectiveBackend } from '../src/auth.ts';
import { base64ByteLength } from '../src/capture.ts';

describe('bun-webview-mcp server', () => {
  test('base64ByteLength calculates exact decoded byte count in O(1)', () => {
    for (const size of [0, 1, 2, 3, 4, 15, 64, 1023, 4096]) {
      const buf = Buffer.alloc(size, 0xab);
      const b64 = buf.toString('base64');
      expect(base64ByteLength(b64)).toBe(buf.byteLength);
    }
  });

  test('parseCookieString and resolveEffectiveBackend handle cookies and headers', () => {
    const parsed = parseCookieString('session_id=abc123; theme=dark; flag');
    expect(parsed).toEqual([
      { name: 'session_id', value: 'abc123', path: '/' },
      { name: 'theme', value: 'dark', path: '/' },
      { name: 'flag', value: '', path: '/' },
    ]);

    // Standard cookies keep default backend
    expect(resolveEffectiveBackend({ cookies: 'a=b' }, 'webkit')).toBe('webkit');
    // Custom HTTP headers auto-select 'chrome'
    expect(resolveEffectiveBackend({ headers: { Authorization: 'Bearer tok' } }, 'webkit')).toBe(
      'chrome',
    );
    // HttpOnly cookies auto-select 'chrome'
    expect(
      resolveEffectiveBackend(
        { cookies: [{ name: 'sid', value: '1', path: '/', httpOnly: true }] },
        'webkit',
      ),
    ).toBe('chrome');
  });

  test('supports full-page screenshot, full browser interactions, auth cookies/headers, and concurrent session requests', async () => {
    const authServer = Bun.serve({
      port: 0,
      fetch(req) {
        const cookieHeader = req.headers.get('cookie') || '';
        const authHeader = req.headers.get('authorization') || '';
        const html = `<!DOCTYPE html>
          <html>
            <head><title>Authenticated Dashboard</title></head>
            <body>
              <div id="server-cookie">${cookieHeader}</div>
              <div id="server-auth">${authHeader}</div>
              <div id="client-storage"></div>
              <script>
                document.getElementById('client-storage').textContent =
                  'ls=' + (localStorage.getItem('auth_tier') || 'none') +
                  ',ss=' + (sessionStorage.getItem('tab_token') || 'none');
              </script>
            </body>
          </html>`;
        return new Response(html, {
          headers: { 'content-type': 'text/html; charset=utf-8' },
        });
      },
    });

    const transport = new StdioClientTransport({
      command: 'bun',
      args: ['run', 'src/index.ts'],
      cwd: `${import.meta.dir}/..`,
    });

    const client = new Client({
      name: 'test-agent-client',
      version: '1.2.0',
    });

    await client.connect(transport);

    try {
      const { tools } = await client.listTools();
      const toolNames = tools.map((t) => t.name);
      expect(toolNames).toContain('screenshot_page');
      expect(toolNames).toContain('browser_open');
      expect(toolNames).toContain('browser_act');
      expect(toolNames).toContain('browser_cookies');
      expect(toolNames).toContain('browser_elements');
      expect(toolNames).toContain('browser_screenshot');
      expect(toolNames).toContain('browser_console');
      expect(toolNames).toContain('browser_close');

      // 1. Test full-page screenshot with 100vh stabilization
      const html = `<!DOCTYPE html>
        <html>
          <head><title>Full Page MCP Test</title></head>
          <body style="margin:0; font-family: sans-serif;">
            <section style="box-sizing: border-box; min-height: 100vh; background: #ff6b6b; padding: 24px;">
              <h1>Hero Section</h1>
            </section>
            <section style="box-sizing: border-box; height: 1600px; background: linear-gradient(#4ecdc4, #1a535c); padding: 24px;">
              <h2>Tall Scrollable Section</h2>
              <p id="bottom-marker" style="margin-top: 1400px;">Bottom Marker Reached</p>
            </section>
          </body>
        </html>`;
      const dataUrl = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;

      const res = await client.callTool({
        name: 'screenshot_page',
        arguments: {
          url: dataUrl,
          width: 1000,
          height: 600,
          fullPage: true,
          format: 'png',
          includeText: true,
        },
      });

      expect(res.isError).toBeFalsy();
      const content = res.content as Array<{
        type: string;
        text?: string;
        data?: string;
        mimeType?: string;
      }>;
      expect(content.length).toBe(2);

      const textBlock = content.find((c) => c.type === 'text');
      const imageBlock = content.find((c) => c.type === 'image');

      expect(textBlock?.text).toContain('Title: Full Page MCP Test');
      expect(textBlock?.text).toContain('Mode: Full-page (1000x2200 CSS px)');
      expect(textBlock?.text).toContain('Bottom Marker Reached');

      expect(imageBlock).toBeDefined();
      expect(imageBlock?.mimeType).toBe('image/png');

      const pngBuffer = Buffer.from(imageBlock?.data ?? '', 'base64');
      expect(pngBuffer.subarray(0, 4).toString('hex')).toBe('89504e47');
      const pixelWidth = pngBuffer.readUInt32BE(16);
      const pixelHeight = pngBuffer.readUInt32BE(20);
      expect(pixelHeight).toBeGreaterThanOrEqual(2200);
      expect(pixelWidth).toBeGreaterThanOrEqual(1000);

      // 2. Test authenticated page capture with cookies + localStorage + sessionStorage on WebKit
      const authUrl = `http://127.0.0.1:${authServer.port}/dashboard`;
      const authShotRes = await client.callTool({
        name: 'screenshot_page',
        arguments: {
          url: authUrl,
          backend: 'webkit',
          cookies: 'session_user=nicat; role=admin',
          localStorage: { auth_tier: 'enterprise' },
          sessionStorage: { tab_token: 'xyz987' },
          includeText: true,
        },
      });
      expect(authShotRes.isError).toBeFalsy();
      const authShotText = (authShotRes.content as Array<{ type: string; text?: string }>).find(
        (c) => c.type === 'text',
      )?.text;
      expect(authShotText).toContain('session_user=nicat');
      expect(authShotText).toContain('role=admin');
      expect(authShotText).toContain('ls=enterprise,ss=xyz987');

      // 3. Test full interactive browser workflow: inputs, paste/fill, select, click, console, cookies
      const interactiveHtml = `<!DOCTYPE html>
        <html>
          <head><title>Interactive Form</title></head>
          <body>
            <input id="email" type="text" placeholder="Enter email" value="old@example.com" />
            <select id="role" onchange="console.log('Role selected:', this.value)">
              <option value="user">User</option>
              <option value="admin">Administrator</option>
            </select>
            <button id="submit-btn" onclick="
              const val = document.getElementById('email').value;
              const role = document.getElementById('role').value;
              document.getElementById('out').textContent = val + ' (' + role + ')';
              console.log('Submitted:', val, role);
            ">Save</button>
            <div id="out">Initial</div>
          </body>
        </html>`;
      const interactiveUrl = `data:text/html;charset=utf-8,${encodeURIComponent(interactiveHtml)}`;

      const openRes = await client.callTool({
        name: 'browser_open',
        arguments: {
          url: interactiveUrl,
          width: 800,
          height: 600,
          includeElements: true,
        },
      });
      expect(openRes.isError).toBeFalsy();
      const openText = (openRes.content as Array<{ type: string; text?: string }>).find(
        (c) => c.type === 'text',
      )?.text;
      expect(openText).toContain('#email');
      expect(openText).toContain('#submit-btn');

      // 4. Dispatch concurrent session calls via Promise.all to verify mutex serialization
      const [pasteRes, selectRes, clickRes] = await Promise.all([
        client.callTool({
          name: 'browser_act',
          arguments: {
            action: 'paste',
            selector: '#email',
            text: 'agent@bun.sh',
            takeScreenshot: false,
          },
        }),
        client.callTool({
          name: 'browser_act',
          arguments: {
            action: 'select',
            selector: '#role',
            label: 'Administrator',
            takeScreenshot: false,
          },
        }),
        client.callTool({
          name: 'browser_act',
          arguments: {
            action: 'click',
            selector: '#submit-btn',
            includeText: true,
            takeScreenshot: true,
          },
        }),
      ]);

      expect(pasteRes.isError).toBeFalsy();
      expect(selectRes.isError).toBeFalsy();
      expect(clickRes.isError).toBeFalsy();

      const clickText = (clickRes.content as Array<{ type: string; text?: string }>).find(
        (c) => c.type === 'text',
      )?.text;
      expect(clickText).toContain('agent@bun.sh (admin)');

      // Check console logs
      const consoleRes = await client.callTool({
        name: 'browser_console',
        arguments: {},
      });
      const consoleText = (consoleRes.content as Array<{ type: string; text?: string }>)[0]?.text;
      expect(consoleText).toContain('Submitted: agent@bun.sh admin');

      // 5. Test browser_cookies tool on active HTTP page
      await client.callTool({
        name: 'browser_open',
        arguments: { url: authUrl, backend: 'webkit', takeScreenshot: false },
      });
      const setCookieRes = await client.callTool({
        name: 'browser_cookies',
        arguments: {
          action: 'set',
          cookies: [{ name: 'active_token', value: 'tok_999', path: '/' }],
        },
      });
      expect(setCookieRes.isError).toBeFalsy();

      const getCookieRes = await client.callTool({
        name: 'browser_cookies',
        arguments: { action: 'get' },
      });
      const getCookieText = (getCookieRes.content as Array<{ type: string; text?: string }>)[0]
        ?.text;
      expect(getCookieText).toContain('tok_999');

      const clearCookieRes = await client.callTool({
        name: 'browser_cookies',
        arguments: { action: 'clear' },
      });
      expect(clearCookieRes.isError).toBeFalsy();

      const closeRes = await client.callTool({
        name: 'browser_close',
        arguments: {},
      });
      expect(closeRes.isError).toBeFalsy();
    } finally {
      await client.close();
      authServer.stop(true);
    }
  }, 30000);
});
