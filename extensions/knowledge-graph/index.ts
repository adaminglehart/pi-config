import type {
  AgentToolResult,
  ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { randomUUID } from "node:crypto";
import { createStore, type QMDStore, type SearchOptions } from "@tobilu/qmd";
import * as fs from "node:fs";
import * as path from "node:path";

const GRAPH_BASE = `${process.env.HOME}/.obsidian/vaults/agents/knowledge`;
const MEMORIES_DIR = path.join(GRAPH_BASE, "memories");
const QMD_DB_PATH = `${process.env.HOME}/.cache/qmd/graph-index.sqlite`;
const COLLECTION_NAME = "knowledge-graph";

type KgResult = AgentToolResult<Record<string, unknown>>;
type FrontmatterValue = string | number | boolean | string[] | null;
type Frontmatter = Record<string, FrontmatterValue>;

type MemoryNote = {
  id: string;
  title: string;
  kind: string | null;
  fullPath: string;
  relativePath: string;
  qmdIndexed: boolean;
};

type ParsedNote = {
  frontmatter: Frontmatter;
  title: string;
  body: string;
};

let store: QMDStore | null = null;

export default function (pi: ExtensionAPI) {
  if (!fs.existsSync(MEMORIES_DIR)) {
    fs.mkdirSync(MEMORIES_DIR, { recursive: true });
  }

  let storePromise: Promise<QMDStore> | null = null;

  async function getStore(): Promise<QMDStore> {
    if (store) return store;
    if (storePromise) return storePromise;

    storePromise = createStore({
      dbPath: QMD_DB_PATH,
      config: {
        collections: {
          [COLLECTION_NAME]: {
            path: GRAPH_BASE,
            pattern: "**/*.md",
          },
        },
      },
    }).then((createdStore: QMDStore) => {
      store = createdStore;
      store.update({ collections: [COLLECTION_NAME] }).catch(console.error);
      return store;
    });

    return storePromise;
  }

  pi.registerTool({
    name: "kg-capture-memory",
    label: "Knowledge Graph: Capture Memory",
    description:
      "Capture a durable note in the personal memory garden. Prefer this for most memories, preferences, research snippets, and ongoing context.",
    promptSnippet:
      "Capture a durable memory note with light metadata and natural links",
    parameters: Type.Object({
      title: Type.String({ description: "Short human-readable title" }),
      content: Type.String({ description: "Main note body in markdown" }),
      kind: Type.Optional(
        Type.String({
          description:
            "Optional soft kind such as preference, project, person, decision, research, or idea",
        }),
      ),
      tags: Type.Optional(
        Type.Array(Type.String(), {
          description: "Optional lightweight tags",
        }),
      ),
      frontmatter: Type.Optional(
        Type.Record(Type.String(), Type.Unknown(), {
          description: "Additional YAML frontmatter fields",
        }),
      ),
      links: Type.Optional(
        Type.Array(Type.String(), {
          description:
            "Related note titles or paths to link in a Related section",
        }),
      ),
    }),
    async execute(
      _toolCallId,
      params,
      _signal,
      _onUpdate,
      _ctx,
    ): Promise<KgResult> {
      const note = await createMemoryNote({
        title: params.title,
        content: params.content,
        kind: params.kind,
        tags: params.tags,
        frontmatter: toFrontmatter(params.frontmatter),
        links: params.links,
      });

      return {
        content: [
          {
            type: "text",
            text: `Captured memory note: ${note.title} at ${note.relativePath}`,
          },
        ],
        details: {
          path: note.fullPath,
          relativePath: note.relativePath,
          id: note.id,
          kind: note.kind,
          qmdIndexed: note.qmdIndexed,
        },
      };
    },
  });

  pi.registerTool({
    name: "kg-update-node",
    label: "Knowledge Graph: Update Memory",
    description:
      "Update an existing memory note. Use this to append new context, refine metadata, or revise the body.",
    promptSnippet: "Update an existing memory note in the knowledge graph",
    parameters: Type.Object({
      path: Type.String({
        description: "Path, filename, or title of the note to update",
      }),
      updates: Type.Object({
        content: Type.Optional(
          Type.String({ description: "Replace the note body" }),
        ),
        append: Type.Optional(
          Type.String({ description: "Append text to the note body" }),
        ),
        tags: Type.Optional(
          Type.Array(Type.String(), {
            description: "Replace the note tags",
          }),
        ),
        links: Type.Optional(
          Type.Array(Type.String(), {
            description: "Append related note links in a Related section",
          }),
        ),
        frontmatter: Type.Optional(
          Type.Record(Type.String(), Type.Unknown(), {
            description: "Frontmatter fields to merge into the note",
          }),
        ),
      }),
    }),
    async execute(
      _toolCallId,
      params,
      _signal,
      _onUpdate,
      _ctx,
    ): Promise<KgResult> {
      const fullPath = await resolvePath(params.path);
      if (!fullPath) {
        return {
          content: [
            { type: "text", text: `Error: Note not found for ${params.path}` },
          ],
          details: {},
        };
      }

      const existing = parseNote(fs.readFileSync(fullPath, "utf-8"));
      const timestamp = new Date().toISOString();
      const mergedFrontmatter: Frontmatter = {
        ...existing.frontmatter,
        ...toFrontmatter(params.updates.frontmatter),
        updated: timestamp,
      };

      if (params.updates.tags) {
        mergedFrontmatter.tags = dedupeStrings(params.updates.tags);
      }

      let body = params.updates.content ?? existing.body;
      if (params.updates.append) {
        body = appendParagraph(body, params.updates.append);
      }
      if (params.updates.links && params.updates.links.length > 0) {
        const relatedSection = await buildRelatedSection(params.updates.links);
        if (relatedSection) {
          body = appendParagraph(body, relatedSection);
        }
      }

      fs.writeFileSync(
        fullPath,
        renderNote({
          title: existing.title,
          frontmatter: mergedFrontmatter,
          body,
        }),
      );

      const indexed = await refreshIndex();

      return {
        content: [{ type: "text", text: `Updated ${path.basename(fullPath)}` }],
        details: { path: fullPath, updated: timestamp, qmdIndexed: indexed },
      };
    },
  });

  pi.registerTool({
    name: "kg-get-node",
    label: "Knowledge Graph: Get Memory",
    description:
      "Retrieve a specific memory note from the knowledge graph by path, filename, or title.",
    promptSnippet: "Get a specific memory note by path or title",
    parameters: Type.Object({
      identifier: Type.String({
        description: "Path, filename, slug, or title of the note",
      }),
    }),
    async execute(
      _toolCallId,
      params,
      _signal,
      _onUpdate,
      _ctx,
    ): Promise<KgResult> {
      const fullPath = await resolvePath(params.identifier);
      if (fullPath) {
        return {
          content: [{ type: "text", text: fs.readFileSync(fullPath, "utf-8") }],
          details: { found: true, source: "filesystem", path: fullPath },
        };
      }

      const s = await getStore().catch(() => null);
      if (s) {
        const results = await s.searchLex(params.identifier, {
          collection: COLLECTION_NAME,
          limit: 5,
        });
        if (results.length > 0) {
          const doc = await s.get(results[0].docid, { includeBody: true });
          if ("body" in doc) {
            return {
              content: [{ type: "text", text: doc.body ?? "" }],
              details: {
                found: true,
                source: "qmd",
                path: doc.filepath,
                score: results[0].score,
              },
            };
          }
        }
      }

      return {
        content: [
          { type: "text", text: `Memory not found: ${params.identifier}` },
        ],
        details: { found: false },
      };
    },
  });

  pi.registerTool({
    name: "kg-query",
    label: "Knowledge Graph: Query",
    description:
      "Hybrid search using QMD — query expansion + multi-signal retrieval + LLM reranking. Best quality results.",
    promptSnippet:
      "Search the memory garden with natural language (best quality)",
    parameters: Type.Object({
      query: Type.String({
        description: "Natural language query — will be auto-expanded",
      }),
      intent: Type.Optional(
        Type.String({
          description: "Optional intent hint to steer retrieval",
        }),
      ),
      limit: Type.Optional(
        Type.Number({ default: 10, description: "Max results" }),
      ),
      explain: Type.Optional(
        Type.Boolean({
          default: false,
          description: "Include retrieval score traces",
        }),
      ),
    }),
    async execute(
      _toolCallId,
      params,
      _signal,
      _onUpdate,
      _ctx,
    ): Promise<KgResult> {
      const s = await getStore().catch(() => null);
      if (!s) {
        return {
          content: [{ type: "text", text: "Error: QMD store not initialized" }],
          details: {},
        };
      }

      const searchOptions: SearchOptions = {
        query: params.query,
        collection: COLLECTION_NAME,
        limit: params.limit || 10,
        rerank: true,
        explain: params.explain,
      };

      if (params.intent) {
        searchOptions.intent = params.intent;
      }

      const results = await s.search(searchOptions);
      const formatted = results
        .map(
          (result, index) =>
            `${index + 1}. **${result.title}** (score: ${result.score.toFixed(3)})\n   Path: ${result.displayPath}\n   ${result.bestChunk.slice(0, 150)}...`,
        )
        .join("\n\n");

      return {
        content: [{ type: "text", text: formatted || "No results found" }],
        details: {
          query: params.query,
          count: results.length,
          results: results.map((result) => ({
            path: result.file,
            displayPath: result.displayPath,
            title: result.title,
            score: result.score,
            bestChunk: result.bestChunk,
          })),
        },
      };
    },
  });

  pi.registerTool({
    name: "kg-search",
    label: "Knowledge Graph: Search",
    description:
      "Fast keyword search (BM25) for note titles, names, and exact terms.",
    promptSnippet: "Fast keyword search of the memory garden",
    parameters: Type.Object({
      q: Type.String({
        description:
          "Search terms — supports exact phrases in quotes and exclusions with -",
      }),
      limit: Type.Optional(Type.Number({ default: 10 })),
    }),
    async execute(
      _toolCallId,
      params,
      _signal,
      _onUpdate,
      _ctx,
    ): Promise<KgResult> {
      const s = await getStore().catch(() => null);
      if (!s) {
        return {
          content: [{ type: "text", text: "Error: QMD store not initialized" }],
          details: {},
        };
      }

      const results = await s.searchLex(params.q, {
        collection: COLLECTION_NAME,
        limit: params.limit || 10,
      });

      const formatted = results
        .map(
          (result, index) =>
            `${index + 1}. **${result.title}** (score: ${result.score.toFixed(3)})\n   Path: ${result.displayPath}`,
        )
        .join("\n\n");

      return {
        content: [{ type: "text", text: formatted || "No results found" }],
        details: {
          query: params.q,
          count: results.length,
          results: results.map((result) => ({
            filepath: result.filepath,
            displayPath: result.displayPath,
            title: result.title,
            score: result.score,
          })),
        },
      };
    },
  });

  pi.registerTool({
    name: "kg-semantic-search",
    label: "Knowledge Graph: Semantic Search",
    description:
      "Vector similarity search for conceptually related memories, even without exact word overlap.",
    promptSnippet: "Semantic search of the memory garden by meaning",
    parameters: Type.Object({
      q: Type.String({
        description: "Describe what you are looking for in natural language",
      }),
      limit: Type.Optional(Type.Number({ default: 10 })),
    }),
    async execute(
      _toolCallId,
      params,
      _signal,
      _onUpdate,
      _ctx,
    ): Promise<KgResult> {
      const s = await getStore().catch(() => null);
      if (!s) {
        return {
          content: [{ type: "text", text: "Error: QMD store not initialized" }],
          details: {},
        };
      }

      const results = await s.searchVector(params.q, {
        collection: COLLECTION_NAME,
        limit: params.limit || 10,
      });

      const formatted = results
        .map(
          (result, index) =>
            `${index + 1}. **${result.title}** (score: ${result.score.toFixed(3)})\n   Path: ${result.displayPath}`,
        )
        .join("\n\n");

      return {
        content: [{ type: "text", text: formatted || "No results found" }],
        details: {
          query: params.q,
          count: results.length,
          results: results.map((result) => ({
            filepath: result.filepath,
            displayPath: result.displayPath,
            title: result.title,
            score: result.score,
          })),
        },
      };
    },
  });

  pi.registerTool({
    name: "kg-get-path",
    label: "Knowledge Graph: Find Path",
    description:
      "Find connection paths between memory notes by traversing Obsidian wikilinks.",
    promptSnippet: "Find paths between two memory notes",
    parameters: Type.Object({
      from: Type.String({ description: "Starting note path or title" }),
      to: Type.String({ description: "Target note path or title" }),
      maxDepth: Type.Optional(Type.Number({ default: 3 })),
    }),
    async execute(
      _toolCallId,
      params,
      _signal,
      _onUpdate,
      _ctx,
    ): Promise<KgResult> {
      const fromPath = await resolvePath(params.from);
      const toPath = await resolvePath(params.to);

      if (!fromPath || !toPath) {
        return {
          content: [
            {
              type: "text",
              text: `Could not resolve: ${!fromPath ? params.from : ""} ${!toPath ? params.to : ""}`,
            },
          ],
          details: {},
        };
      }

      const queue: Array<{ path: string[]; depth: number }> = [
        { path: [fromPath], depth: 0 },
      ];
      const visited = new Set<string>([fromPath]);
      const maxDepth = params.maxDepth || 3;

      while (queue.length > 0) {
        const next = queue.shift();
        if (!next) {
          break;
        }

        const currentPath = next.path;
        const depth = next.depth;
        const current = currentPath[currentPath.length - 1];

        if (current === toPath) {
          const titles = currentPath.map((currentFilePath) =>
            path.basename(currentFilePath, ".md"),
          );
          return {
            content: [
              {
                type: "text",
                text: `Path found (${depth} hops):\n${titles.join(" → ")}`,
              },
            ],
            details: { path: currentPath, depth, titles },
          };
        }

        if (depth >= maxDepth) {
          continue;
        }

        const neighbors = getLinkedEntities(current);
        for (const neighbor of neighbors) {
          if (!visited.has(neighbor)) {
            visited.add(neighbor);
            queue.push({ path: [...currentPath, neighbor], depth: depth + 1 });
          }
        }
      }

      return {
        content: [{ type: "text", text: "No path found within depth limit" }],
        details: {},
      };
    },
  });

  pi.registerTool({
    name: "kg-related",
    label: "Knowledge Graph: Get Related",
    description:
      "Get all notes linked from a given memory note via Obsidian wikilinks.",
    promptSnippet: "Get notes related to a specific memory note",
    parameters: Type.Object({
      path: Type.String({ description: "Note path, slug, or identifier" }),
      limit: Type.Optional(Type.Number({ default: 20 })),
    }),
    async execute(
      _toolCallId,
      params,
      _signal,
      _onUpdate,
      _ctx,
    ): Promise<KgResult> {
      const fullPath = await resolvePath(params.path);
      if (!fullPath) {
        return {
          content: [{ type: "text", text: `Note not found: ${params.path}` }],
          details: {},
        };
      }

      const linked = getLinkedEntities(fullPath, params.limit);
      const titles = linked.map((linkedPath) =>
        path.basename(linkedPath, ".md"),
      );

      return {
        content: [
          {
            type: "text",
            text: `Related to ${path.basename(fullPath, ".md")}:\n${titles.join("\n")}`,
          },
        ],
        details: { source: fullPath, related: titles, count: titles.length },
      };
    },
  });

  pi.registerTool({
    name: "kg-add-edge",
    label: "Knowledge Graph: Link Notes",
    description:
      "Link two memory notes together by appending a wikilink to the source note.",
    promptSnippet: "Link two memory notes together",
    parameters: Type.Object({
      source: Type.String({ description: "Source note path or title" }),
      target: Type.String({ description: "Target note path or title" }),
      relationship: Type.Optional(
        Type.String({
          description: "Optional human-readable relationship label",
        }),
      ),
      context: Type.Optional(
        Type.String({
          description: "Optional context about why the notes relate",
        }),
      ),
    }),
    async execute(
      _toolCallId,
      params,
      _signal,
      _onUpdate,
      _ctx,
    ): Promise<KgResult> {
      const sourcePath = await resolvePath(params.source);
      const targetPath = await resolvePath(params.target);

      if (!sourcePath || !targetPath) {
        return {
          content: [{ type: "text", text: "Could not resolve notes" }],
          details: {},
        };
      }

      const targetName = path.basename(targetPath, ".md");
      const contextParts = [params.relationship, params.context].filter(
        (value): value is string => Boolean(value && value.trim()),
      );
      const linkText =
        contextParts.length > 0
          ? `- [[${targetName}]] — ${contextParts.join(": ")}`
          : `- [[${targetName}]]`;

      fs.writeFileSync(
        sourcePath,
        `${fs.readFileSync(sourcePath, "utf-8").trimEnd()}\n\n## Related\n${linkText}\n`,
      );

      const indexed = await refreshIndex();

      return {
        content: [
          {
            type: "text",
            text: `Linked ${path.basename(sourcePath, ".md")} → ${targetName}`,
          },
        ],
        details: {
          source: sourcePath,
          target: targetPath,
          relationship: params.relationship ?? null,
          qmdIndexed: indexed,
        },
      };
    },
  });

  pi.registerTool({
    name: "kg-refresh-index",
    label: "Knowledge Graph: Refresh Index",
    description:
      "Force re-index the memory garden in QMD after bulk note changes.",
    promptSnippet: "Refresh the QMD index for the memory garden",
    parameters: Type.Object({
      embed: Type.Optional(
        Type.Boolean({
          default: true,
          description: "Also regenerate vector embeddings",
        }),
      ),
    }),
    async execute(
      _toolCallId,
      params,
      _signal,
      _onUpdate,
      _ctx,
    ): Promise<KgResult> {
      const s = await getStore().catch(() => null);
      if (!s) {
        return {
          content: [{ type: "text", text: "Error: QMD store not initialized" }],
          details: {},
        };
      }

      const updateResult = await s.update({ collections: [COLLECTION_NAME] });
      let embedResult: { chunksEmbedded: number } | null = null;
      if (params.embed !== false) {
        embedResult = await s.embed();
      }

      const status = await s.getStatus();

      return {
        content: [
          {
            type: "text",
            text: `Index refreshed: ${updateResult.indexed} indexed, ${updateResult.updated} updated. Embeddings: ${embedResult?.chunksEmbedded || 0} chunks embedded.`,
          },
        ],
        details: {
          indexed: updateResult.indexed,
          updated: updateResult.updated,
          needsEmbedding: updateResult.needsEmbedding,
          chunksEmbedded: embedResult?.chunksEmbedded ?? null,
          totalDocuments: status.totalDocuments,
        },
      };
    },
  });

  pi.registerTool({
    name: "kg-session-summary",
    label: "Knowledge Graph: Session Summary",
    description:
      "Show guidance on what to capture from sessions and the current memory garden status.",
    promptSnippet: "Get memory garden status and capture guidance",
    parameters: Type.Object({}),
    async execute(
      _toolCallId,
      _params,
      _signal,
      _onUpdate,
      _ctx,
    ): Promise<KgResult> {
      const status = await getStore()
        .then((s) => s.getStatus())
        .catch(() => null);

      const text = `
# Memory Garden Status

${status ? `**Documents**: ${status.totalDocuments} indexed` : "QMD store not yet initialized"}

## What to Capture
- Durable preferences and habits
- Decisions and their rationale
- Important people, projects, and open loops
- Research findings or useful references
- Context that is likely to matter again later

## Capture Style
- Prefer natural notes over rigid entity schemas
- Use a soft \`kind\` only when helpful
- Link related notes when the connection is obvious
- Avoid storing trivial chatter or unnecessary sensitive detail

## Available Tools
- **kg-capture-memory** — Create a memory note
- **kg-update-node** — Update a memory note
- **kg-query** — Hybrid search (best quality)
- **kg-search** — Fast keyword search
- **kg-semantic-search** — Vector similarity
- **kg-add-edge** — Link notes
- **kg-get-path** — Find paths between notes
- **kg-related** — Get linked notes
- **kg-refresh-index** — Force re-index
`;

      return {
        content: [{ type: "text", text: text.trim() }],
        details: { status },
      };
    },
  });

  async function createMemoryNote(params: {
    title: string;
    content: string;
    kind?: string;
    tags?: string[];
    frontmatter?: Frontmatter;
    links?: string[];
  }): Promise<MemoryNote> {
    const id = randomUUID().slice(0, 8);
    const timestamp = new Date().toISOString();
    const slug = slugify(params.title) || `memory-${id}`;
    const fullPath = getUniqueMemoryPath(slug, id);
    const relativePath = path.relative(GRAPH_BASE, fullPath);
    const normalizedTags = dedupeStrings([
      ...(params.tags ?? []),
      ...(params.kind ? [params.kind] : []),
    ]);

    const frontmatter: Frontmatter = {
      id,
      title: params.title,
      created: timestamp,
      updated: timestamp,
      ...(params.kind ? { kind: params.kind } : {}),
      ...(normalizedTags.length > 0 ? { tags: normalizedTags } : {}),
      ...(params.frontmatter ?? {}),
    };

    let body = params.content.trim();
    const relatedSection = await buildRelatedSection(params.links ?? []);
    if (relatedSection) {
      body = appendParagraph(body, relatedSection);
    }

    fs.writeFileSync(
      fullPath,
      renderNote({
        title: params.title,
        frontmatter,
        body,
      }),
    );

    const indexed = await refreshIndex();

    return {
      id,
      title: params.title,
      kind: params.kind ?? null,
      fullPath,
      relativePath,
      qmdIndexed: indexed,
    };
  }

  async function refreshIndex(): Promise<boolean> {
    const s = await getStore().catch(() => null);
    if (!s) {
      return false;
    }

    await s.update({ collections: [COLLECTION_NAME] }).catch(console.error);
    return true;
  }

  async function buildRelatedSection(links: string[]): Promise<string> {
    if (links.length === 0) {
      return "";
    }

    const renderedLinks = await Promise.all(
      links.map(async (link) => `- [[${await resolveLinkTarget(link)}]]`),
    );

    return `## Related\n${renderedLinks.join("\n")}`;
  }

  async function resolvePath(identifier: string): Promise<string | null> {
    const normalized = normalizeLinkTarget(identifier);
    const candidates = [
      identifier,
      path.join(GRAPH_BASE, identifier),
      path.join(MEMORIES_DIR, identifier),
      path.join(MEMORIES_DIR, normalized),
    ];

    for (const candidate of candidates) {
      const withExt = candidate.endsWith(".md") ? candidate : `${candidate}.md`;
      if (fs.existsSync(withExt)) {
        return withExt;
      }
    }

    const s = await getStore().catch(() => null);
    if (!s) {
      return null;
    }

    const results = await s.searchLex(identifier, {
      collection: COLLECTION_NAME,
      limit: 5,
    });

    const exactTitleMatch = results.find(
      (result) => result.title.toLowerCase() === identifier.toLowerCase(),
    );
    if (exactTitleMatch) {
      return path.join(GRAPH_BASE, exactTitleMatch.filepath);
    }

    const exactBasenameMatch = results.find(
      (result) => path.basename(result.filepath, ".md") === normalized,
    );
    if (exactBasenameMatch) {
      return path.join(GRAPH_BASE, exactBasenameMatch.filepath);
    }

    const firstResult = results[0];
    return firstResult ? path.join(GRAPH_BASE, firstResult.filepath) : null;
  }

  function getLinkedEntities(filePath: string, limit?: number): string[] {
    const content = fs.readFileSync(filePath, "utf-8");
    const linkRegex = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
    const links: string[] = [];
    let match: RegExpExecArray | null;

    while ((match = linkRegex.exec(content)) !== null) {
      const targetPath = path.join(
        MEMORIES_DIR,
        `${normalizeLinkTarget(match[1])}.md`,
      );
      if (fs.existsSync(targetPath)) {
        links.push(targetPath);
      }
      if (limit && links.length >= limit) {
        break;
      }
    }

    return links;
  }
}

function getUniqueMemoryPath(slug: string, id: string): string {
  const basePath = path.join(MEMORIES_DIR, `${slug}.md`);
  if (!fs.existsSync(basePath)) {
    return basePath;
  }

  return path.join(MEMORIES_DIR, `${slug}-${id}.md`);
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function normalizeLinkTarget(value: string): string {
  return slugify(path.basename(value, ".md"));
}

function appendParagraph(body: string, addition: string): string {
  const trimmedBody = body.trim();
  const trimmedAddition = addition.trim();
  if (!trimmedBody) {
    return trimmedAddition;
  }
  if (!trimmedAddition) {
    return trimmedBody;
  }
  return `${trimmedBody}\n\n${trimmedAddition}`;
}

function dedupeStrings(values: string[]): string[] {
  const normalized = values
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  return [...new Set(normalized)];
}

function renderNote(note: ParsedNote): string {
  return `---\n${serializeFrontmatter(note.frontmatter)}\n---\n\n# ${note.title}\n\n${note.body.trim()}\n`;
}

function serializeFrontmatter(frontmatter: Frontmatter): string {
  return Object.entries(frontmatter)
    .map(([key, value]) => serializeFrontmatterField(key, value))
    .join("\n");
}

function serializeFrontmatterField(
  key: string,
  value: FrontmatterValue,
): string {
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return `${key}: []`;
    }
    return `${key}:\n${value.map((item) => `  - ${formatScalar(item)}`).join("\n")}`;
  }

  return `${key}: ${formatScalar(value)}`;
}

function formatScalar(value: string | number | boolean | null): string {
  if (value === null) {
    return "null";
  }

  if (typeof value === "string") {
    if (value.length === 0) {
      return '""';
    }
    if (/[:#\[\]{}",]|^\s|\s$/.test(value)) {
      return JSON.stringify(value);
    }
    return value;
  }

  return String(value);
}

function parseNote(content: string): ParsedNote {
  if (!content.startsWith("---\n")) {
    const titleMatch = content.match(/^#\s+(.+)$/m);
    return {
      frontmatter: {},
      title: titleMatch ? titleMatch[1].trim() : "Untitled",
      body: content.replace(/^#\s+.+$/m, "").trim(),
    };
  }

  const endIndex = content.indexOf("\n---\n", 4);
  if (endIndex === -1) {
    const titleMatch = content.match(/^#\s+(.+)$/m);
    return {
      frontmatter: {},
      title: titleMatch ? titleMatch[1].trim() : "Untitled",
      body: content.replace(/^#\s+.+$/m, "").trim(),
    };
  }

  const frontmatterBlock = content.slice(4, endIndex);
  const remaining = content.slice(endIndex + 5).trim();
  const titleMatch = remaining.match(/^#\s+(.+)$/m);
  const title = titleMatch ? titleMatch[1].trim() : "Untitled";
  const body = remaining.replace(/^#\s+.+$/m, "").trim();

  return {
    frontmatter: parseFrontmatter(frontmatterBlock),
    title,
    body,
  };
}

function parseFrontmatter(block: string): Frontmatter {
  const frontmatter: Frontmatter = {};
  const lines = block.split("\n");
  let currentArrayKey: string | null = null;

  for (const line of lines) {
    const arrayMatch = line.match(/^\s+-\s+(.*)$/);
    if (arrayMatch && currentArrayKey) {
      const currentValue = frontmatter[currentArrayKey];
      if (Array.isArray(currentValue)) {
        currentValue.push(parseArrayItem(arrayMatch[1]));
      }
      continue;
    }

    const fieldMatch = line.match(/^([A-Za-z0-9_-]+):(?:\s*(.*))?$/);
    if (!fieldMatch) {
      currentArrayKey = null;
      continue;
    }

    const key = fieldMatch[1];
    const rawValue = fieldMatch[2] ?? "";
    if (rawValue === "") {
      frontmatter[key] = [];
      currentArrayKey = key;
      continue;
    }

    frontmatter[key] = parseScalar(rawValue);
    currentArrayKey = null;
  }

  return frontmatter;
}

function parseScalar(value: string): string | number | boolean | null {
  const trimmed = value.trim();

  if (trimmed === "null") {
    return null;
  }
  if (trimmed === "true") {
    return true;
  }
  if (trimmed === "false") {
    return false;
  }
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
    return Number(trimmed);
  }

  return parseArrayItem(trimmed);
}

function parseArrayItem(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }

  return trimmed;
}

function toFrontmatter(
  input: Record<string, unknown> | undefined,
): Frontmatter | undefined {
  if (!input) {
    return undefined;
  }

  const frontmatter: Frontmatter = {};
  for (const [key, value] of Object.entries(input)) {
    const normalized = normalizeFrontmatterValue(value);
    if (normalized !== undefined) {
      frontmatter[key] = normalized;
    }
  }
  return frontmatter;
}

function normalizeFrontmatterValue(
  value: unknown,
): FrontmatterValue | undefined {
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === null
  ) {
    return value;
  }

  if (
    Array.isArray(value) &&
    value.every((item): item is string => typeof item === "string")
  ) {
    return value;
  }

  return undefined;
}

async function resolveLinkTarget(link: string): Promise<string> {
  const directPath = path.join(MEMORIES_DIR, `${normalizeLinkTarget(link)}.md`);
  if (fs.existsSync(directPath)) {
    return path.basename(directPath, ".md");
  }

  return normalizeLinkTarget(link);
}
