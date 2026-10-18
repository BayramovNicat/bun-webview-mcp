import { resolveEffectiveBackend } from './auth.ts';
import { clampDimension, getDefaultBackend } from './capture.ts';
import {
  clearElementOrFocusedInput,
  focusElementInView,
  hoverElementInView,
  selectOptionInView,
  waitForDomCondition,
} from './page-scripts.ts';
import type { AuthOptions, BackendType, BrowserActArgs } from './schemas.ts';

export interface ConsoleLogEntry {
  type: string;
  text: string;
  timestamp: string;
}

const MAX_CONSOLE_LOGS = 200;

export class BrowserSessionManager {
  private view: Bun.WebView | null = null;
  private backend: BackendType = getDefaultBackend();
  private width = 1280;
  private height = 800;
  private profileDirectory?: string;
  private consoleLogs: ConsoleLogEntry[] = [];
  private mutexTail: Promise<unknown> = Promise.resolve();

  /**
   * Serializes operations on the shared Bun.WebView session so concurrent tool calls never trigger ERR_INVALID_STATE.
   */
  runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.mutexTail.then(fn, fn);
    this.mutexTail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  getOrCreateView(
    options?: AuthOptions & {
      backend?: BackendType;
      width?: number;
      height?: number;
      profileDirectory?: string;
    },
  ): {
    view: Bun.WebView;
    backend: BackendType;
    width: number;
    height: number;
  } {
    const requestedBackend = resolveEffectiveBackend(options, this.backend);
    const width = clampDimension(options?.width ?? this.width);
    const height = clampDimension(options?.height ?? this.height);
    const profileDirectory = options?.profileDirectory ?? this.profileDirectory;

    if (
      this.view &&
      (this.backend !== requestedBackend || this.profileDirectory !== profileDirectory)
    ) {
      this.close();
    }

    if (!this.view) {
      this.backend = requestedBackend;
      this.width = width;
      this.height = height;
      this.profileDirectory = profileDirectory;
      this.consoleLogs = [];
      this.view = new Bun.WebView({
        backend: this.backend,
        width: this.width,
        height: this.height,
        ...(profileDirectory ? { dataStore: { directory: profileDirectory } } : {}),
        console: (type, ...args) => {
          const text = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
          this.consoleLogs.push({
            type: String(type),
            text,
            timestamp: new Date().toISOString(),
          });
          if (this.consoleLogs.length > MAX_CONSOLE_LOGS) {
            this.consoleLogs.shift();
          }
        },
      });
    } else if (width !== this.width || height !== this.height) {
      this.updateDimensions(width, height);
    }

    return {
      view: this.view,
      backend: this.backend,
      width: this.width,
      height: this.height,
    };
  }

  getActiveView(): {
    view: Bun.WebView;
    backend: BackendType;
    width: number;
    height: number;
  } {
    if (!this.view) {
      throw new Error(
        'No active browser page is open. Call `browser_open` or `screenshot_page` first.',
      );
    }
    return {
      view: this.view,
      backend: this.backend,
      width: this.width,
      height: this.height,
    };
  }

  getConsoleLogs(clear = false): ConsoleLogEntry[] {
    const logs = [...this.consoleLogs];
    if (clear) {
      this.consoleLogs = [];
    }
    return logs;
  }

  updateDimensions(width: number, height: number): void {
    this.width = clampDimension(width);
    this.height = clampDimension(height);
  }

  async executeAction(args: BrowserActArgs): Promise<string> {
    const { view, width, height } = this.getActiveView();
    const clickCount = (args.clickCount ?? 1) as 1 | 2 | 3;

    switch (args.action) {
      case 'click': {
        if (args.selector) {
          await view.click(args.selector, {
            button: args.button,
            clickCount,
            modifiers: args.modifiers,
            timeout: args.timeoutMs,
          });
          return `Clicked selector '${args.selector}' (button=${args.button}, count=${clickCount})`;
        }
        if (typeof args.x === 'number' && typeof args.y === 'number') {
          await view.click(args.x, args.y, {
            button: args.button,
            clickCount,
            modifiers: args.modifiers,
          });
          return `Clicked coordinates (${args.x}, ${args.y}) (button=${args.button}, count=${clickCount})`;
        }
        throw new Error("Provide either 'selector' or both 'x' and 'y' for click.");
      }

      case 'type':
      case 'paste':
      case 'fill': {
        if (typeof args.text !== 'string') {
          throw new Error(`Provide 'text' for ${args.action} action.`);
        }
        if (args.selector) {
          await view.click(args.selector, { timeout: args.timeoutMs });
        }
        const shouldClear =
          args.action === 'paste' || args.action === 'fill' || args.clear === true;
        if (shouldClear) {
          await clearElementOrFocusedInput(view, args.selector);
        }
        await view.type(args.text);
        if (args.submit) {
          await view.press('Enter');
        }
        return `${shouldClear ? 'Cleared and pasted' : 'Typed'} text (${args.text.length} chars)${args.selector ? ` into '${args.selector}'` : ''}${args.submit ? ' + pressed Enter' : ''}`;
      }

      case 'clear': {
        if (args.selector) {
          await view.click(args.selector, { timeout: args.timeoutMs });
        }
        await clearElementOrFocusedInput(view, args.selector);
        return `Cleared input${args.selector ? ` '${args.selector}'` : ''}`;
      }

      case 'press': {
        if (!args.key) {
          throw new Error("Provide 'key' for press action.");
        }
        if (args.selector) {
          await view.click(args.selector, { timeout: args.timeoutMs });
        }
        await view.press(args.key, {
          modifiers: args.modifiers,
        });
        return `Pressed key '${args.key}'${args.modifiers?.length ? ` with modifiers [${args.modifiers.join('+')}]` : ''}`;
      }

      case 'select': {
        if (!args.selector) {
          throw new Error("Provide 'selector' of the <select> element for select action.");
        }
        const chosen = await selectOptionInView(view, args.selector, {
          value: args.value,
          label: args.label,
          index: args.optionIndex,
        });
        return `Selected option value='${chosen}' in '${args.selector}'`;
      }

      case 'hover': {
        if (!args.selector) {
          throw new Error("Provide 'selector' for hover action.");
        }
        await hoverElementInView(view, args.selector);
        return `Hovered over '${args.selector}'`;
      }

      case 'focus': {
        if (!args.selector) {
          throw new Error("Provide 'selector' for focus action.");
        }
        await focusElementInView(view, args.selector);
        return `Focused '${args.selector}'`;
      }

      case 'scroll': {
        const dx = args.x ?? 0;
        const dy = args.y ?? 500;
        await view.scroll(dx, dy);
        return `Scrolled by (${dx}, ${dy})`;
      }

      case 'scrollTo': {
        if (!args.selector) {
          throw new Error("Provide 'selector' for scrollTo action.");
        }
        await view.scrollTo(args.selector, {
          block: args.block,
          timeout: args.timeoutMs,
        });
        return `Scrolled to '${args.selector}' (block=${args.block})`;
      }

      case 'wait': {
        if (args.selector || args.text) {
          await waitForDomCondition(
            view,
            { selector: args.selector, text: args.text },
            args.timeoutMs,
          );
          return args.selector
            ? `Waited for selector '${args.selector}'`
            : `Waited for text '${args.text}'`;
        }
        const ms = args.waitMs ?? 1000;
        await Bun.sleep(ms);
        return `Waited ${ms} ms`;
      }

      case 'evaluate': {
        if (!args.script) {
          throw new Error("Provide 'script' for evaluate action.");
        }
        const evalResult = await view.evaluate(args.script);
        return `Evaluation result: ${JSON.stringify(evalResult, null, 2)}`;
      }

      case 'navigate': {
        if (!args.url) {
          throw new Error("Provide 'url' for navigate action.");
        }
        await view.navigate(args.url);
        return `Navigated to ${args.url}`;
      }

      case 'reload': {
        await view.reload();
        return 'Reloaded page';
      }

      case 'goBack': {
        await view.goBack();
        return 'Navigated back';
      }

      case 'goForward': {
        await view.goForward();
        return 'Navigated forward';
      }

      case 'resize': {
        const newW = clampDimension(args.width ?? width);
        const newH = clampDimension(args.height ?? height);
        await view.resize(newW, newH);
        this.updateDimensions(newW, newH);
        return `Resized viewport to ${newW}x${newH}`;
      }
    }
  }

  close(): boolean {
    if (this.view) {
      try {
        this.view.close();
      } catch {}
      this.view = null;
      return true;
    }
    return false;
  }
}
