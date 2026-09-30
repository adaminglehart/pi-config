/**
 * Time limit for LSP requests, so that a hung server cannot block the tool.
 */
import {
  CancellationTokenSource,
  type MessageConnection,
  type RequestType,
} from "vscode-languageserver-protocol/node";

/** A cold server can load the full project before it answers the first request. */
export const LSP_REQUEST_TIMEOUT_MS = 30_000;

export class LspRequestTimeoutError extends Error {}

export async function sendRequestWithTimeout<P, R, E>(
  connection: MessageConnection,
  type: RequestType<P, R, E>,
  params: P,
): Promise<R> {
  const cancellation = new CancellationTokenSource();
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      cancellation.cancel();
      reject(
        new LspRequestTimeoutError(
          `LSP ${type.method} timed out after ${LSP_REQUEST_TIMEOUT_MS / 1000}s`,
        ),
      );
    }, LSP_REQUEST_TIMEOUT_MS);
  });
  try {
    return await Promise.race([
      connection.sendRequest(type, params, cancellation.token),
      expired,
    ]);
  } finally {
    clearTimeout(timer);
    cancellation.dispose();
  }
}
