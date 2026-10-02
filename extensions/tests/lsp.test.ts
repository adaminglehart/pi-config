import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";
import { test } from "bun:test";
import { createMessageConnection, RequestType, type WorkspaceEdit } from "vscode-languageserver-protocol/node";
import { sendRequestWithTimeout } from "../lsp/lsp-request-timeout";
import { applyWorkspaceEdit } from "../lsp/lsp-workspace-edit";

test("LSP requests return results and reject server errors", async () => {
  const toServer = new PassThrough();
  const toClient = new PassThrough();
  const client = createMessageConnection(toClient, toServer);
  const server = createMessageConnection(toServer, toClient);
  const request = new RequestType<{ value: string }, string, void>("test/echo");
  const emptyRequest = new RequestType<null, string, void>("test/empty");
  server.onRequest(request, ({ value }) => {
    if (value === "fail") throw new Error("Test server error");
    return value;
  });
  server.onRequest(emptyRequest, () => "empty");
  client.listen();
  server.listen();
  try {
    assert.equal(await sendRequestWithTimeout(client, request, { value: "result" }), "result");
    assert.equal(await sendRequestWithTimeout(client, emptyRequest, undefined), "empty");
    await assert.rejects(sendRequestWithTimeout(client, request, { value: "fail" }), /Test server error/);
  } finally {
    client.dispose();
    server.dispose();
    toServer.destroy();
    toClient.destroy();
  }
});

test("LSP rename applies text edits and rejects snippet edits before writes", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-lsp-edit-"));
  const file = join(directory, "rename.ts");
  try {
    writeFileSync(file, "const oldName = 1;\n");
    const range = { start: { line: 0, character: 6 }, end: { line: 0, character: 13 } };
    const uri = pathToFileURL(file).href;
    const snippetEdit: WorkspaceEdit = {
      documentChanges: [{
        textDocument: { uri, version: null },
        edits: [
          { range, newText: "newName" },
          { range, snippet: { kind: "snippet", value: "${1:newName}" } },
        ],
      }],
    };
    assert.throws(() => applyWorkspaceEdit(snippetEdit, "oldName"), /snippet edits/);
    assert.equal(readFileSync(file, "utf8"), "const oldName = 1;\n");
    const edits = applyWorkspaceEdit({
      documentChanges: [{
        textDocument: { uri, version: null },
        edits: [{ range, newText: "newName", annotationId: "rename" }],
      }],
    }, "oldName");
    assert.equal(edits[0].editCount, 1);
    assert.equal(readFileSync(file, "utf8"), "const newName = 1;\n");
  } finally {
    rmSync(directory, { recursive: true });
  }
});
