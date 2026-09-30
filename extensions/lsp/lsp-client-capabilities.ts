/**
 * Client capabilities sent in the LSP `initialize` request.
 */
import {
  MarkupKind,
  SymbolKind,
  type ClientCapabilities,
} from "vscode-languageserver-protocol";

const ALL_SYMBOL_KINDS: SymbolKind[] = Array.from(
  { length: SymbolKind.TypeParameter },
  (_, index) => (index + 1) as SymbolKind,
);

export const LSP_CLIENT_CAPABILITIES: ClientCapabilities = {
  window: { workDoneProgress: true },
  workspace: {
    configuration: true,
    workspaceFolders: true,
    workspaceEdit: { documentChanges: true },
    symbol: {
      dynamicRegistration: false,
      symbolKind: { valueSet: ALL_SYMBOL_KINDS },
    },
  },
  textDocument: {
    synchronization: {
      didSave: true,
      dynamicRegistration: false,
    },
    publishDiagnostics: { versionSupport: true },
    diagnostic: {
      dynamicRegistration: false,
      relatedDocumentSupport: false,
    },
    hover: { contentFormat: [MarkupKind.Markdown, MarkupKind.PlainText] },
    definition: { linkSupport: true },
    implementation: { linkSupport: true },
    typeDefinition: { linkSupport: true },
    references: { dynamicRegistration: false },
    rename: { dynamicRegistration: false, prepareSupport: false },
    callHierarchy: { dynamicRegistration: false },
    documentSymbol: {
      hierarchicalDocumentSymbolSupport: true,
      symbolKind: { valueSet: ALL_SYMBOL_KINDS },
    },
  },
};
