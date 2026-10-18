import type { InteractiveElementInfo } from './schemas.ts';

interface SavedElementHeightRecord {
  el: HTMLElement;
  h: number;
  inlineH: string;
  inlineHPrio: string;
  inlineMinH: string;
  inlineMinHPrio: string;
  modified: boolean;
}

declare global {
  interface Window {
    __mcpOrigHeights?: SavedElementHeightRecord[];
  }
}

/**
 * Serializes a real TypeScript function and executes it in the page context with JSON-encoded arguments.
 */
export async function evalInPage<R, A extends unknown[]>(
  view: Bun.WebView,
  fn: (...args: A) => R | Promise<R>,
  ...args: A
): Promise<R> {
  const serializedArgs = args.map((arg) => JSON.stringify(arg)).join(',');
  return (await view.evaluate(`(${fn.toString()})(${serializedArgs})`)) as R;
}

/**
 * Unified requestAnimationFrame polling helper for waiting on a selector or text content.
 */
export async function waitForDomCondition(
  view: Bun.WebView,
  condition: { selector?: string; text?: string },
  timeoutMs = 15000,
): Promise<void> {
  await evalInPage(
    view,
    (cond, maxWaitMs) =>
      new Promise<boolean>((resolve, reject) => {
        const deadline = performance.now() + Math.max(100, maxWaitMs);
        function check() {
          if (cond.selector) {
            const el = document.querySelector(cond.selector);
            if (el) {
              const rect = el.getBoundingClientRect();
              if (rect.width > 0 || rect.height > 0) {
                resolve(true);
                return;
              }
            }
          } else if (cond.text) {
            const bodyText = document.body ? document.body.innerText : '';
            if (bodyText.includes(cond.text)) {
              resolve(true);
              return;
            }
          } else {
            resolve(true);
            return;
          }

          if (performance.now() >= deadline) {
            const label = cond.selector ? `selector: ${cond.selector}` : `text: ${cond.text}`;
            reject(new Error(`Timeout waiting for ${label}`));
            return;
          }
          requestAnimationFrame(check);
        }
        check();
      }),
    condition,
    timeoutMs,
  );
}

export async function clearElementOrFocusedInput(
  view: Bun.WebView,
  selector?: string,
): Promise<void> {
  await evalInPage(
    view,
    (sel) => {
      const target = (
        sel ? document.querySelector(sel) : document.activeElement
      ) as HTMLElement | null;
      if (!target) return;
      target.focus?.();
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
        const proto =
          target instanceof HTMLTextAreaElement
            ? HTMLTextAreaElement.prototype
            : HTMLInputElement.prototype;
        const desc = Object.getOwnPropertyDescriptor(proto, 'value');
        if (desc?.set) {
          desc.set.call(target, '');
        } else {
          target.value = '';
        }
        target.dispatchEvent(
          new InputEvent('input', { bubbles: true, inputType: 'deleteContent' }),
        );
        target.dispatchEvent(new Event('change', { bubbles: true }));
      } else if (target.isContentEditable) {
        document.execCommand('selectAll', false);
        document.execCommand('delete', false);
      }
    },
    selector ?? null,
  );
}

export async function selectOptionInView(
  view: Bun.WebView,
  selector: string,
  option: { value?: string; label?: string; index?: number },
): Promise<string> {
  return await evalInPage(
    view,
    (sel, opt) => {
      const el = document.querySelector(sel);
      if (!el || !(el instanceof HTMLSelectElement)) {
        throw new Error(`Element is not a <select>: ${sel}`);
      }
      const options = Array.from(el.options);
      let target: HTMLOptionElement | undefined;
      if (typeof opt.value === 'string') {
        target = options.find((o) => o.value === opt.value);
      } else if (typeof opt.label === 'string') {
        const expected = opt.label.trim();
        target = options.find((o) => (o.label || o.textContent || '').trim() === expected);
      } else if (typeof opt.index === 'number') {
        target = options[opt.index];
      }
      if (!target) {
        throw new Error(`Matching <option> not found in ${sel}`);
      }
      el.value = target.value;
      target.selected = true;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return target.value;
    },
    selector,
    option,
  );
}

export async function hoverElementInView(view: Bun.WebView, selector: string): Promise<void> {
  await evalInPage(
    view,
    (sel) => {
      const el = document.querySelector(sel);
      if (!el) throw new Error(`Element not found for hover: ${sel}`);
      el.scrollIntoView({ block: 'nearest', behavior: 'instant' });
      const rect = el.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      for (const type of [
        'pointerover',
        'mouseover',
        'pointerenter',
        'mouseenter',
        'pointermove',
        'mousemove',
      ]) {
        el.dispatchEvent(
          new MouseEvent(type, {
            bubbles: !type.endsWith('enter'),
            cancelable: true,
            clientX: cx,
            clientY: cy,
            view: window,
          }),
        );
      }
    },
    selector,
  );
}

export async function focusElementInView(view: Bun.WebView, selector: string): Promise<void> {
  await evalInPage(
    view,
    (sel) => {
      const el = document.querySelector(sel) as HTMLElement | null;
      if (!el) throw new Error(`Element not found: ${sel}`);
      el.focus?.();
    },
    selector,
  );
}

export async function getInteractiveElements(
  view: Bun.WebView,
  limit = 150,
): Promise<InteractiveElementInfo[]> {
  return await evalInPage(
    view,
    (maxItems) => {
      const query = [
        'a[href]',
        'button',
        "input:not([type='hidden'])",
        'textarea',
        'select',
        "[role='button']",
        "[role='link']",
        "[role='checkbox']",
        "[role='menuitem']",
        "[role='tab']",
        "[contenteditable='true']",
        "[contenteditable='']",
      ].join(',');

      function buildUniqueSelector(el: Element): string {
        if (el.id && /^[a-zA-Z][\w-]*$/.test(el.id)) {
          const byId = '#' + CSS.escape(el.id);
          if (document.querySelectorAll(byId).length === 1) return byId;
        }
        for (const attr of [
          'data-testid',
          'data-test',
          'data-qa',
          'name',
          'aria-label',
          'placeholder',
        ]) {
          const val = el.getAttribute(attr);
          if (val) {
            const candidate = `${el.tagName.toLowerCase()}[${attr}=${JSON.stringify(val)}]`;
            try {
              if (document.querySelectorAll(candidate).length === 1) {
                return candidate;
              }
            } catch {}
          }
        }
        const parts: string[] = [];
        let cur: Element | null = el;
        while (cur && cur.nodeType === 1 && cur !== document.body && parts.length < 5) {
          let part = cur.tagName.toLowerCase();
          if (cur.id && /^[a-zA-Z][\w-]*$/.test(cur.id)) {
            parts.unshift('#' + CSS.escape(cur.id));
            break;
          }
          const parentEl: Element | null = cur.parentElement;
          if (parentEl) {
            const tagName = cur.tagName;
            const siblings = Array.from(parentEl.children).filter(
              (c: Element) => c.tagName === tagName,
            );
            if (siblings.length > 1) {
              part += `:nth-of-type(${siblings.indexOf(cur) + 1})`;
            }
          }
          parts.unshift(part);
          cur = parentEl;
        }
        return parts.join(' > ');
      }

      const nodes = Array.from(document.querySelectorAll(query));
      const results: InteractiveElementInfo[] = [];
      for (const el of nodes) {
        if (results.length >= maxItems) break;
        const rect = el.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) continue;
        const cs = getComputedStyle(el);
        if (cs.visibility === 'hidden' || cs.display === 'none' || parseFloat(cs.opacity) === 0) {
          continue;
        }

        const htmlEl = el as HTMLElement;
        const tag = el.tagName.toLowerCase();
        const text = (
          htmlEl.innerText ||
          el.getAttribute('aria-label') ||
          el.getAttribute('title') ||
          el.getAttribute('alt') ||
          ''
        )
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 120);

        const item: InteractiveElementInfo = {
          index: results.length + 1,
          tag,
          selector: buildUniqueSelector(el),
          text,
          rect: {
            x: Math.round(rect.left + window.scrollX),
            y: Math.round(rect.top + window.scrollY),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          },
        };

        const typeAttr = el.getAttribute('type');
        if (typeAttr) item.type = typeAttr;
        const roleAttr = el.getAttribute('role');
        if (roleAttr) item.role = roleAttr;
        const placeholderAttr = el.getAttribute('placeholder');
        if (placeholderAttr) item.placeholder = placeholderAttr;

        if (
          'value' in el &&
          typeof (el as HTMLInputElement).value === 'string' &&
          (el as HTMLInputElement).value !== ''
        ) {
          item.value = (el as HTMLInputElement).value.slice(0, 120);
        }
        if (tag === 'a' && el.getAttribute('href')) {
          item.href = el.getAttribute('href')!;
        }
        if (
          'checked' in el &&
          typeof (el as HTMLInputElement).checked === 'boolean' &&
          (item.type === 'checkbox' || item.type === 'radio')
        ) {
          item.checked = (el as HTMLInputElement).checked;
        }
        if ('disabled' in el && (el as HTMLInputElement).disabled) {
          item.disabled = true;
        }

        results.push(item);
      }
      return results;
    },
    limit,
  );
}

export interface PreparedPageMetadata {
  scrollWidth: number;
  scrollHeight: number;
  title: string;
  textContent?: string;
  elements?: InteractiveElementInfo[];
}

/**
 * Single-pass pre-capture preparation:
 * - Optionally scrolls down and back to top to trigger lazy-loaded assets
 * - Waits up to 1.5s for web fonts and eager/triggered images
 * - Optionally records initial element heights for 100vh stabilization on WebKit
 * - Extracts page dimensions, title, and optional visible text
 */
export async function preparePageForCapture(
  view: Bun.WebView,
  params: {
    maxHeight: number;
    shouldScroll: boolean;
    snapshotHeights: boolean;
    includeText: boolean;
    includeElements: boolean;
  },
): Promise<PreparedPageMetadata> {
  const meta = await evalInPage(
    view,
    async (opts) => {
      const getScrollHeight = () =>
        Math.max(
          document.body?.scrollHeight || 0,
          document.documentElement?.scrollHeight || 0,
          document.body?.offsetHeight || 0,
          document.documentElement?.offsetHeight || 0,
          window.innerHeight || 0,
        );

      const getScrollWidth = () =>
        Math.max(
          document.body?.scrollWidth || 0,
          document.documentElement?.scrollWidth || 0,
          window.innerWidth || 0,
        );

      if (opts.shouldScroll) {
        const step = Math.max(window.innerHeight || 600, 400);
        let current = 0;
        let limit = Math.min(getScrollHeight(), opts.maxHeight);
        while (current < limit) {
          current = Math.min(current + step, limit);
          window.scrollTo(0, current);
          await new Promise((r) => setTimeout(r, 60));
          limit = Math.min(getScrollHeight(), opts.maxHeight);
        }
        window.scrollTo(0, 0);
        await new Promise((r) => setTimeout(r, 80));
      }

      try {
        await Promise.race([
          (async () => {
            if (document.fonts?.ready) {
              await document.fonts.ready;
            }
            const imgs = Array.from(document.querySelectorAll('img'));
            await Promise.all(
              imgs
                .filter((img) => !img.complete && img.loading !== 'lazy')
                .map(
                  (img) =>
                    new Promise((res) => {
                      img.addEventListener('load', res, { once: true });
                      img.addEventListener('error', res, { once: true });
                    }),
                ),
            );
          })(),
          new Promise((r) => setTimeout(r, 1500)),
        ]);
      } catch {}

      if (opts.snapshotHeights) {
        const els = Array.from(document.querySelectorAll('body *')) as HTMLElement[];
        window.__mcpOrigHeights = els.map((el) => ({
          el,
          h: el.getBoundingClientRect().height,
          inlineH: el.style.getPropertyValue('height'),
          inlineHPrio: el.style.getPropertyPriority('height'),
          inlineMinH: el.style.getPropertyValue('min-height'),
          inlineMinHPrio: el.style.getPropertyPriority('min-height'),
          modified: false,
        }));
      }

      return {
        scrollWidth: getScrollWidth(),
        scrollHeight: getScrollHeight(),
        title: document.title || '',
        textContent: opts.includeText
          ? document.body
            ? document.body.innerText.trim()
            : ''
          : undefined,
      };
    },
    params,
  );

  if (params.includeElements) {
    return {
      ...meta,
      elements: await getInteractiveElements(view),
    };
  }

  return meta;
}

/**
 * Prevents 100vh / min-height: 100vh elements from stretching to the full page height after viewport resize.
 */
export async function stabilizePostResizeHeight(
  view: Bun.WebView,
  initialViewportHeight: number,
): Promise<number> {
  return await evalInPage(
    view,
    (baseHeight) => {
      const deltaVp = window.innerHeight - baseHeight;
      const records = window.__mcpOrigHeights;
      if (deltaVp > 100 && Array.isArray(records)) {
        for (let i = records.length - 1; i >= 0; i--) {
          const item = records[i];
          const newH = item.el.getBoundingClientRect().height;
          if (newH - item.h > deltaVp * 0.2) {
            const childrenHeight = Array.from(item.el.children).reduce(
              (sum, c) => sum + c.getBoundingClientRect().height,
              0,
            );
            if (childrenHeight < newH * 0.6) {
              item.el.style.setProperty('min-height', `${item.h}px`, 'important');
              item.el.style.setProperty('height', `${item.h}px`, 'important');
              item.modified = true;
            }
          }
        }
      }
      return Math.max(
        document.body?.scrollHeight || 0,
        document.documentElement?.scrollHeight || 0,
        baseHeight,
      );
    },
    initialViewportHeight,
  );
}

/**
 * Restores any inline height overrides applied during WebKit full-page capture.
 */
export async function restorePreResizeStyles(view: Bun.WebView): Promise<void> {
  await evalInPage(view, () => {
    const records = window.__mcpOrigHeights;
    if (Array.isArray(records)) {
      for (const item of records) {
        if (item.modified) {
          if (item.inlineH) {
            item.el.style.setProperty('height', item.inlineH, item.inlineHPrio);
          } else {
            item.el.style.removeProperty('height');
          }
          if (item.inlineMinH) {
            item.el.style.setProperty('min-height', item.inlineMinH, item.inlineMinHPrio);
          } else {
            item.el.style.removeProperty('min-height');
          }
        }
      }
      delete window.__mcpOrigHeights;
    }
  });
}
