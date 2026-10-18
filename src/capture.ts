import { navigateWithAuth, resolveEffectiveBackend } from './auth.ts';
import {
  preparePageForCapture,
  restorePreResizeStyles,
  stabilizePostResizeHeight,
  waitForDomCondition,
} from './page-scripts.ts';
import type { BackendType, CapturePageOptions, CapturePageResult, ImageFormat } from './schemas.ts';

export function getDefaultBackend(): BackendType {
  return process.platform === 'darwin' ? 'webkit' : 'chrome';
}

export function clampDimension(value: number, min = 1, max = 16384): number {
  return Math.max(min, Math.min(max, Math.round(value)));
}

/**
 * Computes exact decoded byte length from a base64 string in O(1) time without allocating a Buffer.
 */
export function base64ByteLength(b64: string): number {
  const len = b64.length;
  if (len === 0) return 0;
  let padding = 0;
  if (b64.endsWith('==')) padding = 2;
  else if (b64.endsWith('=')) padding = 1;
  return Math.floor((len * 3) / 4) - padding;
}

export async function captureFromView(
  view: Bun.WebView,
  backend: BackendType,
  options: CapturePageOptions = {},
  restoreViewportAfter = false,
): Promise<CapturePageResult> {
  const width = clampDimension(options.width ?? 1280);
  const height = clampDimension(options.height ?? 800);
  const fullPage = options.fullPage ?? true;
  const maxHeight = clampDimension(options.maxHeight ?? 12000);

  let format: ImageFormat = options.format ?? 'jpeg';
  if (format === 'webp' && backend === 'webkit') {
    format = 'jpeg';
  }

  const quality = Math.max(1, Math.min(100, Math.round(options.quality ?? 80)));
  const scrollForLazyLoad = options.scrollForLazyLoad ?? fullPage;
  const waitMs = Math.max(0, options.waitMs ?? 300);

  if (options.url) {
    await navigateWithAuth(view, backend, options.url, options);
  }

  if (options.waitForSelector) {
    await waitForDomCondition(
      view,
      { selector: options.waitForSelector },
      options.waitTimeoutMs ?? 15000,
    );
  }

  const meta = await preparePageForCapture(view, {
    maxHeight,
    shouldScroll: scrollForLazyLoad,
    snapshotHeights: fullPage && backend === 'webkit',
    includeText: Boolean(options.includeText),
    includeElements: Boolean(options.includeElements),
  });

  if (waitMs > 0) {
    await Bun.sleep(waitMs);
  }

  let capturedWidth = width;
  let capturedHeight = height;
  let base64: string;

  if (fullPage) {
    const targetHeight = clampDimension(Math.max(meta.scrollHeight, height), 1, maxHeight);

    if (backend === 'chrome') {
      const shot = (await view.cdp('Page.captureScreenshot', {
        format,
        ...(format === 'png' ? {} : { quality }),
        captureBeyondViewport: true,
        clip: {
          x: 0,
          y: 0,
          width,
          height: targetHeight,
          scale: 1,
        },
      })) as { data: string };
      base64 = shot.data;
      capturedWidth = width;
      capturedHeight = targetHeight;
    } else {
      await view.resize(width, targetHeight);
      const stabilizedHeight = await stabilizePostResizeHeight(view, height);
      const finalHeight = clampDimension(stabilizedHeight, 1, maxHeight);

      if (finalHeight !== targetHeight) {
        await view.resize(width, finalHeight);
      }

      base64 = (await view.screenshot({
        format,
        quality,
        encoding: 'base64',
      })) as string;

      capturedWidth = width;
      capturedHeight = finalHeight;

      if (restoreViewportAfter) {
        await restorePreResizeStyles(view);
        await view.resize(width, height);
      }
    }
  } else {
    base64 = (await view.screenshot({
      format,
      quality,
      encoding: 'base64',
    })) as string;
  }

  let savedTo: string | undefined;
  if (options.savePath) {
    await Bun.write(options.savePath, Buffer.from(base64, 'base64'));
    savedTo = options.savePath;
  }

  const mimeType = format === 'png' ? 'image/png' : format === 'webp' ? 'image/webp' : 'image/jpeg';

  return {
    url: view.url,
    title: view.title || meta.title,
    backend,
    format,
    mimeType,
    base64,
    byteLength: base64ByteLength(base64),
    viewport: { width, height },
    capturedSize: { width: capturedWidth, height: capturedHeight },
    fullPage,
    savedTo,
    textContent: meta.textContent,
    elements: meta.elements,
  };
}

export async function screenshotPageOneShot(
  options: CapturePageOptions & { url: string },
): Promise<CapturePageResult> {
  const backend = resolveEffectiveBackend(options, getDefaultBackend());
  const width = clampDimension(options.width ?? 1280);
  const height = clampDimension(options.height ?? 800);

  await using view = new Bun.WebView({
    backend,
    width,
    height,
  });

  return await captureFromView(view, backend, options, false);
}
