---
name: dev-browser-extension
description: Pi extension for browser automation using the dev-browser tool. Provides sandboxed JavaScript execution with Playwright Page API for web scraping, testing, and automation.
---

# Dev Browser Extension

Browser automation tool integrated into Pi as a custom tool.

## Tool: `browser_run`

Execute JavaScript in a sandboxed browser environment using Playwright.

### When to Use

- **Web scraping** - Extract data from websites
- **Testing** - Verify page functionality, check elements
- **Form automation** - Fill and submit forms
- **Screenshots** - Capture page images
- **Page inspection** - Get element snapshots, titles, URLs

### Parameters

```typescript
{
  script: string;        // JavaScript code to execute (required)
  browser?: string;      // Browser instance name (default: "default")
  headless?: boolean;    // Run without visible window (default: true)
  connect?: string;      // CDP URL or "auto" to connect to Chrome
  timeout?: number;      // Script timeout in seconds (default: 30)
}
```

### Script Environment

Scripts run in **QuickJS WASM sandbox** (NOT Node.js):

**Available globals:**
- `browser` - Browser handle with `getPage()`, `newPage()`, `listPages()`, `closePage()`
- `console` - log, warn, error, info (output captured)
- `saveScreenshot(buf, name)` - Save screenshot to temp dir
- `writeFile(name, data)` - Write file to temp dir
- `readFile(name)` - Read file from temp dir

**NOT available:**
- `require()` / `import()` - No modules
- `process` - No process access
- `fs` / `path` / `os` - No filesystem access
- `fetch` / `WebSocket` - No direct network

Pages returned by `browser.getPage()` and `browser.newPage()` are full Playwright Page objects.

### Examples

**Navigate and extract title:**
```javascript
const page = await browser.getPage("main");
await page.goto("https://example.com");
console.log(JSON.stringify({
  title: await page.title(),
  url: page.url()
}));
```

**Extract multiple elements:**
```javascript
const page = await browser.getPage("scraping");
await page.goto("https://news.ycombinator.com");
const links = await page.$$eval(".titleline > a", 
  els => els.map(e => ({ title: e.textContent, url: e.href })).slice(0, 5)
);
console.log(JSON.stringify(links, null, 2));
```

**Screenshot:**
```javascript
const page = await browser.getPage("main");
await page.goto("https://example.com");
const buf = await page.screenshot({ fullPage: true });
const path = await saveScreenshot(buf, "home.png");
console.log(JSON.stringify({ screenshot: path }));
```

**Multi-step workflow (pages persist):**
```javascript
// First call - create named page
const page = await browser.getPage("checkout");
await page.goto("https://shop.example.com/cart");
await page.fill("#email", "user@example.com");
console.log("Step 1 complete");

// Second call - same page state preserved
const page = await browser.getPage("checkout");  // Same page!
await page.click("button:has-text('Checkout')");
console.log(JSON.stringify({ url: page.url() }));
```

**Connect to running Chrome:**
```javascript
// Requires Chrome launched with --remote-debugging-port=9222
const page = await browser.getPage("debug");
console.log(JSON.stringify({
  tabs: await browser.listPages()
}));
```
Use parameter `connect: "http://localhost:9222"` or `connect: "auto"`.

### Common Page Methods

| Method | Use For |
|--------|---------|
| `page.goto(url)` | Navigate to URL |
| `page.title()` | Get page title |
| `page.url()` | Get current URL |
| `page.click(selector)` | Click element |
| `page.fill(selector, value)` | Fill input field |
| `page.type(selector, text)` | Type character by character |
| `page.evaluate(fn)` | Run JS in page context |
| `page.$$eval(sel, fn)` | Run function on all matches |
| `page.locator(selector)` | Create reusable locator |
| `page.getByRole(role, opts)` | Find by ARIA role |
| `page.waitForSelector(sel)` | Wait for element |
| `page.waitForURL(pattern)` | Wait for navigation |
| `page.screenshot(opts)` | Capture buffer → use `saveScreenshot()` |
| `page.snapshotForAI(opts)` | AI-optimized element tree with refs |

### Browser Global API

| Method | Returns | Purpose |
|--------|---------|---------|
| `browser.getPage(name)` | Page | Get/create named page (persists across calls) |
| `browser.newPage()` | Page | Create anonymous page (temporary) |
| `browser.listPages()` | Array | List all tabs: `{id, url, title, name}` |
| `browser.closePage(name)` | void | Close named page |

### Output Guidelines

- Use `console.log(JSON.stringify(data))` for structured output
- Always await async operations (sandbox is async)
- Handle errors with try/catch in scripts
- Use named pages for multi-step workflows
- Anonymous pages (`newPage()`) are cleaned up after script

### Limitations

- No module loading (`require`/`import`)
- No direct filesystem/network access
- Plain JavaScript only (no TypeScript in `page.evaluate`)
- Memory and CPU limits enforced
- Scripts timeout after 30 seconds by default

### Commands

The extension provides slash commands:

- `/browser-status` - Check daemon status
- `/browser-stop` - Stop daemon and close browsers
- `/browser-install` - Install dev-browser and browsers
