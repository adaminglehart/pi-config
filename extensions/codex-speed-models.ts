import type { Api, Provider, StreamOptions } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const variants = [
  { model: "gpt-6-astra", tier: "fast" },
  { model: "gpt-6.1-sol", tier: "fast" },
  { model: "gpt-6-luna", tier: "fast" },
  { model: "gpt-6-astra", tier: "ultrafast" },
] as const;

export function createCodexSpeedProvider(): Provider {
  const base = builtinProviders().find((provider) => provider.id === "openai-codex");
  if (!base) throw new Error("The built-in Codex provider is not available");

  function tierPayload(options: StreamOptions | undefined, tier: "fast" | "ultrafast"): StreamOptions["onPayload"] {
    return async (payload, model) => {
      const replacement = await options?.onPayload?.(payload, model);
      const request = replacement ?? payload;
      if (typeof request !== "object" || request === null || Array.isArray(request)) {
        throw new Error("Codex request must be an object");
      }
      return { ...request, model: model.id, service_tier: tier === "fast" ? "priority" : "ultrafast" };
    };
  }

  return {
    ...base,
    stream(model, context, options) {
      const variant = variants.find((entry) => model.id === `${entry.model}-${entry.tier}`);
      if (!variant) return base.stream(model, context, options);
      return base.stream<Api>({ ...model, id: variant.model }, context, {
        ...options,
        onPayload: tierPayload(options, variant.tier),
      });
    },
    streamSimple(model, context, options) {
      const variant = variants.find((entry) => model.id === `${entry.model}-${entry.tier}`);
      if (!variant) return base.streamSimple(model, context, options);
      return base.streamSimple({ ...model, id: variant.model }, context, {
        ...options,
        onPayload: tierPayload(options, variant.tier),
      });
    },
  };
}

export default function (pi: ExtensionAPI) {
  pi.registerProvider(createCodexSpeedProvider());
}
