import type { Api, Model, ProviderHeaders } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

export type ModelAuth =
  | {
      ok: true;
      model: Model<Api>;
      apiKey: string | undefined;
      headers: ProviderHeaders | undefined;
    }
  | { ok: false; error: string };

/** Resolve the request auth for a model that the caller already has. */
export async function getModelAuth(
  modelRegistry: ModelRegistry,
  model: Model<Api> | undefined,
): Promise<ModelAuth> {
  if (!model) return { ok: false, error: "No active model selected." };

  const auth = await modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) {
    return {
      ok: false,
      error: `Authentication for ${model.provider}/${model.id} failed: ${auth.error}`,
    };
  }
  return { ok: true, model, apiKey: auth.apiKey, headers: auth.headers };
}

/** Find a configured model by provider and id, then resolve its request auth. */
export async function findModelAuth(
  modelRegistry: ModelRegistry,
  provider: string,
  modelId: string,
): Promise<ModelAuth> {
  const model = modelRegistry.find(provider, modelId);
  if (!model) {
    return { ok: false, error: `Model ${provider}/${modelId} is not available.` };
  }
  return getModelAuth(modelRegistry, model);
}
