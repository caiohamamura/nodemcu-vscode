---
name: devtools-automation
description: Automates and inspects running VS Code/Electron instances using the Chrome DevTools Protocol (CDP) for E2E user-level validation.
---

# DevTools Automation Skill

This skill allows an agent to connect to a running Extension Development Host or any Electron-based editor window with remote debugging enabled (e.g., port `9222`) and simulate user actions, query UI tree-view states, toggle checkboxes, or execute command palette commands.

## Prerequisites

- The Extension Development Host (or target IDE window) must be launched with the `--remote-debugging-port=9222` flag.
- Node.js version 22+ (so `fetch` and global `WebSocket` are natively available).

## Command Index

Use the bundled script at [.claude/SKILLS/devtools-automation/scripts/cdp-control.js](file:///c:/Users/caioh/src/vscode/nodemcu-vscode/.claude/SKILLS/devtools-automation/scripts/cdp-control.js) to execute the following automation tasks:

### 1. Ensure Sidebar Is Visible
Focuses and expands the NodeMCU extension sidebar activity item.
```bash
node .claude/SKILLS/devtools-automation/scripts/cdp-control.js focus-sidebar
```

### 2. Expand All Collapsed Sidebar Panes
Expands any view sections (like C Modules, Lua Modules) that are currently collapsed.
```bash
node .claude/SKILLS/devtools-automation/scripts/cdp-control.js expand-panes
```

### 3. Inspect Current UI State
Retrieves lists of all visible items in the C Modules, Lua Modules, and Device Explorer panes including checkbox status (`true`/`false`).
```bash
node .claude/SKILLS/devtools-automation/scripts/cdp-control.js get-state
```

### 4. Toggle a Module Checkbox
Clicks the checkbox next to any C or Lua module to add or remove it from the configuration.
```bash
node .claude/SKILLS/devtools-automation/scripts/cdp-control.js toggle <module-name>
# Example: Toggle the "adc" module
node .claude/SKILLS/devtools-automation/scripts/cdp-control.js toggle adc
```

### 5. Click or Double-Click a List Row
Performs click and double-click actions on a list row element containing specific text (e.g., to trigger task actions or ports).
```bash
node .claude/SKILLS/devtools-automation/scripts/cdp-control.js click-row <row-text>
# Example: Click/Trigger the "Build Firmware" task row
node .claude/SKILLS/devtools-automation/scripts/cdp-control.js click-row "Build Firmware"
```

### 6. Execute a Command Palette Command
Simulates pressing F1, typing a VS Code command, and pressing Enter to execute it.
```bash
node .claude/SKILLS/devtools-automation/scripts/cdp-control.js run-command "<command-text>"
# Example: Initialize the project configuration
node .claude/SKILLS/devtools-automation/scripts/cdp-control.js run-command "NodeMCU: Initialize Project"
```

### 7. Reload the Window
Forces a reload of the extension host to test clean activation or reset state.
```bash
node .claude/SKILLS/devtools-automation/scripts/cdp-control.js reload-window
```

### 8. Stream Console Logs in Real-time
Enables DevTools runtime and system console logging. The command runs persistently and streams all IDE `console.log` statements, debugger output, and internal logs.
```bash
node .claude/SKILLS/devtools-automation/scripts/cdp-control.js capture-console
```

## How It Works Under the Hood

The automation client communicates with Electron's Chrome instance using standard Chrome DevTools Protocol (CDP) messages sent over WebSockets:
1. It queries `http://127.0.0.1:9222/json` to discover the WebSocket URL of the renderer.
2. It connects to the target WebSocket and calls `Runtime.enable` to allow JS evaluation.
3. For mouse/interaction clicks, it queries elements in the DOM (`document.querySelector`) and fires native DOM events (e.g. `.click()` or `new Event('input')`).
4. For keyboard shortcuts, it dispatches synthetic key events using `Input.dispatchKeyEvent` with virtual key codes (e.g. `112` for `F1`, `13` for `Enter`, `27` for `Escape`).
