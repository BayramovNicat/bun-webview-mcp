import type { CapturePageResult, InteractiveElementInfo } from './schemas.ts';

const MAX_TEXT_PREVIEW_CHARS = 8000;

export function formatElementsList(elements: InteractiveElementInfo[]): string {
  if (elements.length === 0) {
    return 'No interactive elements found on page.';
  }
  return elements
    .map((el) => {
      const attrs: string[] = [];
      if (el.type) attrs.push(`type="${el.type}"`);
      if (el.role) attrs.push(`role="${el.role}"`);
      if (el.placeholder) {
        attrs.push(`placeholder=${JSON.stringify(el.placeholder)}`);
      }
      if (el.value !== undefined) {
        attrs.push(`value=${JSON.stringify(el.value)}`);
      }
      if (el.checked !== undefined) attrs.push(`checked=${el.checked}`);
      if (el.disabled) attrs.push('disabled');
      if (el.href) attrs.push(`href=${JSON.stringify(el.href)}`);
      const attrStr = attrs.length > 0 ? ` (${attrs.join(', ')})` : '';
      const labelStr = el.text ? ` "${el.text}"` : '';
      return `[${el.index}] <${el.tag}>${attrStr}${labelStr} -> selector: ${el.selector} @ (${el.rect.x},${el.rect.y} ${el.rect.width}x${el.rect.height})`;
    })
    .join('\n');
}

export function formatScreenshotResponse(result: CapturePageResult, extraInfo?: string) {
  const summaryLines = [
    `URL: ${result.url}`,
    `Title: ${result.title || '(untitled)'}`,
    `Mode: ${result.fullPage ? 'Full-page' : 'Viewport'} (${result.capturedSize.width}x${result.capturedSize.height} CSS px)`,
    `Format: ${result.mimeType} (${(result.byteLength / 1024).toFixed(1)} KB, backend: ${result.backend})`,
  ];

  if (result.savedTo) {
    summaryLines.push(`Saved to: ${result.savedTo}`);
  }
  if (extraInfo) {
    summaryLines.push(extraInfo);
  }
  if (result.elements !== undefined) {
    summaryLines.push(
      `\n--- Interactive Elements (${result.elements.length}) ---\n${formatElementsList(result.elements)}`,
    );
  }
  if (result.textContent !== undefined) {
    const truncated =
      result.textContent.length > MAX_TEXT_PREVIEW_CHARS
        ? `${result.textContent.slice(0, MAX_TEXT_PREVIEW_CHARS)}\n...[truncated]`
        : result.textContent;
    summaryLines.push(`\n--- Page Text ---\n${truncated}`);
  }

  return {
    content: [
      {
        type: 'text' as const,
        text: summaryLines.join('\n'),
      },
      {
        type: 'image' as const,
        data: result.base64,
        mimeType: result.mimeType,
      },
    ],
  };
}

export function formatTextResponse(text: string) {
  return {
    content: [
      {
        type: 'text' as const,
        text,
      },
    ],
  };
}

export function formatToolError(toolName: string, error: unknown) {
  const msg = error instanceof Error ? error.message : String(error);
  return {
    isError: true,
    content: [
      {
        type: 'text' as const,
        text: `Tool '${toolName}' failed: ${msg}`,
      },
    ],
  };
}
