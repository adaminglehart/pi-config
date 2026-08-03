import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

interface ModelReference {
  provider: string;
  model: string;
}

const FAST_MODEL = "{{model.fast}}";
const DEFAULT_MODEL = "{{model.default}}";

function parseModelReference(value: string): ModelReference | undefined {
  const separator = value.indexOf("/");
  if (separator <= 0 || separator >= value.length - 1) {
    return undefined;
  }

  return {
    provider: value.slice(0, separator),
    model: value.slice(separator + 1),
  };
}

async function switchModel(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  reference: ModelReference | undefined,
  label: string,
): Promise<void> {
  if (!reference) {
    ctx.ui.notify(`Could not determine the ${label} model`, "warning");
    return;
  }

  const model = ctx.modelRegistry.find(reference.provider, reference.model);
  if (!model) {
    ctx.ui.notify(
      `Could not find ${reference.provider}/${reference.model} for ${label} model`,
      "warning",
    );
    return;
  }

  const switched = await pi.setModel(model);
  if (!switched) {
    ctx.ui.notify(`Authentication unavailable for ${model.id}`, "warning");
    return;
  }

  ctx.ui.notify(`Switched to ${model.id}`, "info");
}

export default function modelSwitchExtension(pi: ExtensionAPI): void {
  pi.registerCommand("fast", {
    description: "Switch to the fast model",
    handler: async (_args, ctx) => {
      await switchModel(
        pi,
        ctx,
        parseModelReference(FAST_MODEL),
        "fast",
      );
    },
  });

  pi.registerCommand("default", {
    description: "Switch to pi's default model",
    handler: async (_args, ctx) => {
      await switchModel(pi, ctx, parseModelReference(DEFAULT_MODEL), "default");
    },
  });
}
