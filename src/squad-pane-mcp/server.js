#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// How many lines to capture from tmux scrollback
const CAPTURE_LINES = 500;

// Minimum lines to match for reliable suffix matching (avoids false positives
// from repeated status lines or prompts)
const MIN_MATCH_LINES = 3;

// Per-pane state tracking
const paneState = new Map();

/**
 * Capture raw pane output from tmux.
 * Returns an array of lines (trailing empties trimmed).
 */
async function captureTmuxPane(paneId) {
  const { stdout } = await execFileAsync("tmux", [
    "capture-pane", "-p", "-t", paneId, "-S", `-${CAPTURE_LINES}`, "-E", "-",
  ]);
  // Split into lines, trim trailing empty lines
  const lines = stdout.split("\n");
  while (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

/**
 * Find where old content ends in the new capture using suffix matching.
 *
 * Strategy: take the last MIN_MATCH_LINES of lastContent as an anchor.
 * Search for that exact sequence in currentLines. If found, everything
 * after the match is new content.
 *
 * Returns the index in currentLines where new content begins,
 * or -1 if no match found (gap in output).
 */
function findNewContentStart(lastContent, currentLines) {
  if (lastContent.length < MIN_MATCH_LINES) {
    // Not enough previous content for reliable matching — treat as gap
    return -1;
  }

  // Anchor = last MIN_MATCH_LINES lines of previous capture
  const anchorSize = Math.min(MIN_MATCH_LINES, lastContent.length);
  const anchor = lastContent.slice(-anchorSize);

  // Search for anchor sequence in currentLines, starting from the end
  // (most likely location) and scanning backwards
  for (let i = currentLines.length - anchorSize; i >= 0; i--) {
    let match = true;
    for (let j = 0; j < anchorSize; j++) {
      if (currentLines[i + j] !== anchor[j]) {
        match = false;
        break;
      }
    }
    if (match) {
      // New content starts right after the anchor
      return i + anchorSize;
    }
  }

  return -1; // No match — output scrolled past what we had
}

// Create the MCP server
const server = new McpServer({
  name: "squad-pane-mcp",
  version: "1.0.0",
});

server.tool(
  "capture-pane-delta",
  "Capture only NEW tmux pane output since the last check. Returns new lines plus a small overlap for context. Much more efficient than full capture-pane for monitoring workers — avoids re-reading hundreds of lines the captain already saw.",
  {
    paneId: z.string().describe("tmux pane ID (e.g., '%3')"),
    overlap: z
      .number()
      .int()
      .min(0)
      .max(50)
      .default(5)
      .describe("Lines of previously-seen content to include for continuity (default: 5)"),
    reset: z
      .boolean()
      .default(false)
      .describe("Clear tracking state for this pane and return a full capture"),
  },
  async ({ paneId, overlap = 5, reset = false }) => {
    // Capture current pane content
    let currentLines;
    try {
      currentLines = await captureTmuxPane(paneId);
    } catch (err) {
      return {
        content: [
          {
            type: "text",
            text: `Error capturing pane ${paneId}: ${err.message}`,
          },
        ],
        isError: true,
      };
    }

    if (currentLines.length === 0) {
      // Update state even for empty pane
      paneState.set(paneId, {
        paneId,
        lastContent: [],
        lastCaptureTime: Date.now(),
        totalLinesSeen: 0,
      });
      return {
        content: [
          {
            type: "text",
            text: `[pane ${paneId} | empty | first check: true]\n(pane is empty)`,
          },
        ],
      };
    }

    // If reset requested, clear state and return full capture
    if (reset) {
      paneState.set(paneId, {
        paneId,
        lastContent: currentLines,
        lastCaptureTime: Date.now(),
        totalLinesSeen: currentLines.length,
      });
      return {
        content: [
          {
            type: "text",
            text: `[pane ${paneId} | ${currentLines.length} lines | reset: true]\n${currentLines.join("\n")}`,
          },
        ],
      };
    }

    const state = paneState.get(paneId);

    // First check — no prior state
    if (!state) {
      paneState.set(paneId, {
        paneId,
        lastContent: currentLines,
        lastCaptureTime: Date.now(),
        totalLinesSeen: currentLines.length,
      });
      return {
        content: [
          {
            type: "text",
            text: `[pane ${paneId} | ${currentLines.length} lines | first check: true]\n${currentLines.join("\n")}`,
          },
        ],
      };
    }

    // Quick check: content unchanged?
    if (
      currentLines.length === state.lastContent.length &&
      currentLines.join("\n") === state.lastContent.join("\n")
    ) {
      // Update timestamp but not content
      state.lastCaptureTime = Date.now();
      return {
        content: [
          {
            type: "text",
            text: `[pane ${paneId} | no new output]`,
          },
        ],
      };
    }

    // Find where new content begins
    const newStart = findNewContentStart(state.lastContent, currentLines);

    let resultLines;
    let header;

    if (newStart === -1) {
      // No match found — output scrolled past what we had, return full capture
      resultLines = currentLines;
      header = `[pane ${paneId} | ${currentLines.length} lines | gap detected — showing full capture]`;
    } else if (newStart >= currentLines.length) {
      // Match found but no new content after it
      state.lastCaptureTime = Date.now();
      state.lastContent = currentLines;
      return {
        content: [
          {
            type: "text",
            text: `[pane ${paneId} | no new output]`,
          },
        ],
      };
    } else {
      // We have new content — include overlap lines for context
      const overlapStart = Math.max(0, newStart - overlap);
      resultLines = currentLines.slice(overlapStart);
      const newCount = currentLines.length - newStart;
      const overlapCount = newStart - overlapStart;
      header = `[pane ${paneId} | ${newCount} new lines | ${overlapCount} overlap | first check: false]`;
    }

    // Update state
    state.lastContent = currentLines;
    state.lastCaptureTime = Date.now();
    state.totalLinesSeen += resultLines.length;

    return {
      content: [
        {
          type: "text",
          text: `${header}\n${resultLines.join("\n")}`,
        },
      ],
    };
  }
);

// Start server
const transport = new StdioServerTransport();
await server.connect(transport);
