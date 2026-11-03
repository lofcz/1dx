import React, { useRef } from "react";
import { Box, Text, useBoxMetrics, type DOMElement } from "ink";

export function ActionMenu({ items, selectedIndex }: {
  items: Array<{ id: string; shortcut: string; label: string }>;
  selectedIndex: number;
}) {
  const viewport = useRef<DOMElement>(null);
  const { clientHeight } = useBoxMetrics(viewport);
  const visibleRows = Math.max(1, clientHeight);
  const offset = Math.max(0, Math.min(items.length - visibleRows, selectedIndex - visibleRows + 1));

  return (
    <Box flexDirection="column" flexGrow={1} minHeight={1}>
      <Box flexShrink={0}><Text dimColor wrap="truncate-end">Actions (↑↓ Enter, or keys):</Text></Box>
      <Box ref={viewport} flexDirection="column" flexGrow={1} overflow="hidden" contentOffsetY={offset}>
        <Box flexDirection="column" flexShrink={0}>
          {items.length === 0 && <Text dimColor>No actions configured. Ctrl+C to exit.</Text>}
          {items.map((item, index) => (
            <Text key={item.id} color={index === selectedIndex ? "cyan" : undefined} wrap="truncate-end">
              {index === selectedIndex ? "❯ " : "  "}{item.shortcut}. {item.label}
            </Text>
          ))}
        </Box>
      </Box>
    </Box>
  );
}
