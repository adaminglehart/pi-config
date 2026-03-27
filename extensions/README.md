# Pi Extensions for Agent Platform

This directory contains custom Pi extensions that enhance the agent's capabilities for working with the homelab agent platform codebase.

## Available Extensions

### code-navigator.ts
**Purpose**: Intelligent code analysis and navigation for autonomous agents

**Tools provided**:
- `analyze_project` - Analyzes project structure, detects build systems, identifies key files and directories
- `find_related` - Finds related files (tests, interfaces, implementations, configs) for a given file  
- `summarize_file` - Generates concise summaries of files without reading entire content

**Languages supported**: Go, TypeScript/JavaScript, Rust, Gleam, Python

**Key features**:
- Proper output truncation to avoid context overflow
- Custom TUI rendering for better readability
- Intelligent purpose detection for directories and files
- Handles mixed-language projects (like this Go+Gleam codebase)

**Use cases**:
- Understanding unfamiliar codebases quickly
- Finding test files for a given source file
- Getting project overview without reading every file
- Identifying build systems and entry points

## Usage

Extensions in this directory are auto-loaded when pi runs from the project root. To manually load:

```bash
pi --extension .pi/extensions/code-navigator.ts
```

## Development

When adding new extensions:
1. Follow the naming convention: `kebab-case.ts`
2. Include JSDoc comments explaining purpose and usage
3. Implement proper error handling and output truncation
4. Add custom TUI rendering where appropriate
5. Update this README

For extension development patterns, see the [Pi extensions documentation](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/extensions.md).
