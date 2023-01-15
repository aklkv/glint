import {
  Connection,
  FileChangeType,
  ServerCapabilities,
  SymbolInformation,
  TextDocuments,
  TextDocumentSyncKind,
  InitializeParams as BaseInitializeParams,
  CodeActionTriggerKind,
  CodeActionKind,
} from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { GlintCompletionItem } from './glint-language-server.js';
import { LanguageServerPool } from './pool.js';
import { GetIRRequest } from './messages.cjs';
import { ConfigManager } from './config-manager.js';
import type * as ts from 'typescript';

export const capabilities: ServerCapabilities = {
  textDocumentSync: TextDocumentSyncKind.Full,
  completionProvider: {
    resolveProvider: true,
    // By default `@` won't trigger autocompletion, but it's an important character
    // for us since it signifies the beginning of an arg name.
    triggerCharacters: ['.', '@'],
  },
  referencesProvider: true,
  hoverProvider: true,
  codeActionProvider: {
    codeActionKinds: [CodeActionKind.QuickFix],
  },
  definitionProvider: true,
  workspaceSymbolProvider: true,
  renameProvider: {
    prepareProvider: true,
  },
};

export type BindingArgs = {
  openDocuments: TextDocuments<TextDocument>;
  connection: Connection;
  pool: LanguageServerPool;
  configManager: ConfigManager;
};

interface FormattingAndPreferences {
  format?: ts.FormatCodeSettings;
  preferences?: ts.UserPreferences;
}

interface InitializeParams extends BaseInitializeParams {
  initializationOptions?: {
    typescript?: FormattingAndPreferences;
    javascript?: FormattingAndPreferences;
  };
}

export function bindLanguageServerPool({
  connection,
  pool,
  openDocuments,
  configManager,
}: BindingArgs): void {
  connection.onInitialize((config: InitializeParams) => {
    if (config.initializationOptions?.typescript?.format) {
      configManager.updateTsJsFormatConfig(
        'typescript',
        config.initializationOptions.typescript.format
      );
    }

    if (config.initializationOptions?.typescript?.preferences) {
      configManager.updateTsJsUserPreferences(
        'typescript',
        config.initializationOptions.typescript.preferences
      );
    }

    if (config.initializationOptions?.javascript?.format) {
      configManager.updateTsJsFormatConfig(
        'javascript',
        config.initializationOptions.javascript.format
      );
    }

    if (config.initializationOptions?.javascript?.preferences) {
      configManager.updateTsJsUserPreferences(
        'javascript',
        config.initializationOptions.javascript.preferences
      );
    }

    return { capabilities };
  });

  openDocuments.onDidOpen(({ document }) => {
    pool.withServerForURI(document.uri, ({ server, scheduleDiagnostics }) => {
      server.openFile(document.uri, document.getText());
      scheduleDiagnostics();
    });
  });

  openDocuments.onDidClose(({ document }) => {
    pool.withServerForURI(document.uri, ({ server }) => {
      server.closeFile(document.uri);
    });
  });

  openDocuments.onDidChangeContent(({ document }) => {
    pool.withServerForURI(document.uri, ({ server, scheduleDiagnostics }) => {
      server.updateFile(document.uri, document.getText());
      scheduleDiagnostics();
    });
  });

  connection.onCodeAction(({ textDocument, range, context }) => {
    return pool.withServerForURI(textDocument.uri, ({ server }) => {
      // The user actually asked for the fix
      // @see https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/#codeActionTriggerKind
      if (context.triggerKind === CodeActionTriggerKind.Invoked) {
        let language = server.getLanguageType(textDocument.uri);
        let formating = configManager.getFormatCodeSettingsFor(language);
        let preferences = configManager.getUserSettingsFor(language);
        let diagnostics = context.diagnostics;

        return server.getCodeActions(
          textDocument.uri,
          CodeActionKind.QuickFix,
          range,
          diagnostics,
          formating,
          preferences
        );
      }

      return [];
    });
  });

  connection.onPrepareRename(({ textDocument, position }) => {
    return pool.withServerForURI(textDocument.uri, ({ server }) =>
      server.prepareRename(textDocument.uri, position)
    );
  });

  connection.onRenameRequest(({ textDocument, position, newName }) => {
    return pool.withServerForURI(textDocument.uri, ({ server }) =>
      server.getEditsForRename(textDocument.uri, position, newName)
    );
  });

  connection.onCompletion(async ({ textDocument, position }) => {
    // Pause briefly to allow any editor change events to be transmitted as well.
    // VS Code explicitly sends the the autocomplete request BEFORE it sends the
    // document update notification.
    await new Promise((r) => setTimeout(r, 25));

    return pool.withServerForURI(textDocument.uri, ({ server }) =>
      server.getCompletions(textDocument.uri, position)
    );
  });

  connection.onCompletionResolve((item) => {
    // SAFETY: We should only ever get completion resolution requests for items we ourselves produced
    let glintItem = item as GlintCompletionItem;

    return (
      pool.withServerForURI(glintItem.data.uri, ({ server }) =>
        server.getCompletionDetails(glintItem)
      ) ?? item
    );
  });

  connection.onHover(({ textDocument, position }) => {
    return pool.withServerForURI(textDocument.uri, ({ server }) =>
      server.getHover(textDocument.uri, position)
    );
  });

  connection.onDefinition(({ textDocument, position }) => {
    return pool.withServerForURI(textDocument.uri, ({ server }) =>
      server.getDefinition(textDocument.uri, position)
    );
  });

  connection.onReferences(({ textDocument, position }) => {
    return pool.withServerForURI(textDocument.uri, ({ server }) =>
      server.getReferences(textDocument.uri, position)
    );
  });

  connection.onWorkspaceSymbol(({ query }) => {
    let symbols: Array<SymbolInformation> = [];
    pool.forEachServer(({ server }) => {
      symbols.push(...server.findSymbols(query));
    });
    return symbols;
  });

  connection.onRequest(GetIRRequest.type, ({ uri }) => {
    return pool.withServerForURI(uri, ({ server }) => server.getTransformedContents(uri));
  });

  connection.onDidChangeWatchedFiles(({ changes }) => {
    pool.forEachServer(({ server, scheduleDiagnostics }) => {
      for (let change of changes) {
        if (change.type === FileChangeType.Created) {
          server.watchedFileWasAdded(change.uri);
        } else if (change.type === FileChangeType.Deleted) {
          server.watchedFileWasRemoved(change.uri);
        } else {
          server.watchedFileDidChange(change.uri);
        }
      }

      scheduleDiagnostics();
    });
  });
}
