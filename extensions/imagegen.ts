import { mkdir, writeFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import {
  formatSize,
  type ExtensionAPI,
  withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";

const IMAGE_MODEL = "gpt-image-2";
const REQUEST_TIMEOUT_MS = 5 * 60 * 1000;

const QualitySchema = StringEnum(["auto", "low", "medium", "high"] as const);

const ImagegenParamsSchema = Type.Object({
  prompt: Type.String({ description: "Detailed description of the image to generate" }),
  path: Type.String({
    description:
      "Output file path, relative to the current working directory or absolute. Must end in .png, .jpg, .jpeg, or .webp",
  }),
  quality: Type.Optional(
    QualitySchema,
  ),
  size: Type.Optional(
    Type.String({
      description:
        'Image size. Use "auto" or WIDTHxHEIGHT, such as 1024x1024 or 1536x864. Width and height must be divisible by 16',
    }),
  ),
});

type ImagegenParams = Static<typeof ImagegenParamsSchema>;
type ImageQuality = Static<typeof QualitySchema>;
type OutputFormat = "png" | "jpeg" | "webp";
type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
type JsonObject = { [key: string]: JsonValue };

interface ImagegenDetails {
  path: string;
  model: string;
  format: OutputFormat;
  quality: ImageQuality;
  size: string;
  bytes: number;
  revisedPrompt?: string;
}

interface ParsedImageResponse {
  imageBase64: string;
  quality: ImageQuality;
  size: string;
  revisedPrompt?: string;
}

function normalizePath(path: string): string {
  return path.startsWith("@") ? path.slice(1) : path;
}

function outputFormatForPath(path: string): OutputFormat {
  switch (extname(path).toLowerCase()) {
    case ".png":
      return "png";
    case ".jpg":
    case ".jpeg":
      return "jpeg";
    case ".webp":
      return "webp";
    default:
      throw new Error("Image output path must end in .png, .jpg, .jpeg, or .webp");
  }
}

function mimeTypeForFormat(format: OutputFormat): string {
  return format === "jpeg" ? "image/jpeg" : `image/${format}`;
}

function jsonObject(value: JsonValue): JsonObject | undefined {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    return undefined;
  }
  return value;
}

function stringValue(object: JsonObject, key: string): string | undefined {
  const value = object[key];
  return typeof value === "string" ? value : undefined;
}

function apiErrorMessage(payload: JsonValue, fallback: string): string {
  const payloadObject = jsonObject(payload);
  const errorObject = payloadObject ? jsonObject(payloadObject.error ?? null) : undefined;
  return errorObject ? stringValue(errorObject, "message") ?? fallback : fallback;
}

function parseImageResponse(payload: JsonValue): ParsedImageResponse {
  const payloadObject = jsonObject(payload);
  const data = payloadObject?.data;
  const firstImage = Array.isArray(data) ? jsonObject(data[0] ?? null) : undefined;
  const imageBase64 = firstImage ? stringValue(firstImage, "b64_json") : undefined;

  if (!imageBase64) {
    throw new Error("OpenAI returned no image data");
  }

  const quality = stringValue(payloadObject ?? {}, "quality");
  const normalizedQuality: ImageQuality =
    quality === "low" || quality === "medium" || quality === "high" ? quality : "auto";

  return {
    imageBase64,
    quality: normalizedQuality,
    size: stringValue(payloadObject ?? {}, "size") ?? "auto",
    revisedPrompt: firstImage ? stringValue(firstImage, "revised_prompt") : undefined,
  };
}

export default function imagegen(pi: ExtensionAPI) {
  pi.registerTool<typeof ImagegenParamsSchema, ImagegenDetails>({
    name: "imagegen",
    label: "ImageGen",
    description:
      "Generate one image with OpenAI GPT Image 2 and save it to a local file. Each call uses the separately billed OpenAI API. The output path must end in .png, .jpg, .jpeg, or .webp.",
    promptSnippet: "Generate an image with OpenAI GPT Image 2 and save it to a file",
    promptGuidelines: [
      "Use imagegen only when the user asks to create or generate an image.",
      "Each imagegen call uses the billable OpenAI API, so do not generate extra variants unless the user asks for them.",
    ],
    parameters: ImagegenParamsSchema,

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const normalizedPath = normalizePath(params.path);
      const absolutePath = resolve(ctx.cwd, normalizedPath);
      const format = outputFormatForPath(absolutePath);

      return withFileMutationQueue(absolutePath, async () => {
        const providerAuth = await ctx.modelRegistry.getProviderAuth("openai");
        const apiKey = providerAuth?.auth.apiKey;
        if (!apiKey) {
          throw new Error(
            "OpenAI image generation needs separate API billing. Set OPENAI_API_KEY or run /login openai with an API key; ChatGPT subscription login does not provide Images API access.",
          );
        }

        onUpdate?.({
          content: [
            {
              type: "text",
              text: `Generating ${normalizedPath} with ${IMAGE_MODEL}...`,
            },
          ],
          details: {
            path: absolutePath,
            model: IMAGE_MODEL,
            format,
            quality: params.quality ?? "auto",
            size: params.size ?? "auto",
            bytes: 0,
          },
        });

        const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
        const requestSignal = signal
          ? AbortSignal.any([signal, timeoutSignal])
          : timeoutSignal;
        const response = await fetch("https://api.openai.com/v1/images/generations", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: IMAGE_MODEL,
            prompt: params.prompt,
            output_format: format,
            quality: params.quality ?? "auto",
            size: params.size ?? "auto",
          }),
          signal: requestSignal,
        });

        const responseText = await response.text();
        const payload = JSON.parse(responseText) as JsonValue;
        if (!response.ok) {
          throw new Error(
            `OpenAI image generation failed (${response.status}): ${apiErrorMessage(payload, response.statusText)}`,
          );
        }

        const generated = parseImageResponse(payload);
        const imageBytes = Buffer.from(generated.imageBase64, "base64");
        if (imageBytes.length === 0) {
          throw new Error("OpenAI returned empty image data");
        }

        await mkdir(dirname(absolutePath), { recursive: true });
        await writeFile(absolutePath, imageBytes);

        return {
          content: [
            {
              type: "text",
              text: `Generated image: ${absolutePath} (${formatSize(imageBytes.length)})`,
            },
            {
              type: "image",
              data: generated.imageBase64,
              mimeType: mimeTypeForFormat(format),
            },
          ],
          details: {
            path: absolutePath,
            model: IMAGE_MODEL,
            format,
            quality: generated.quality,
            size: generated.size,
            bytes: imageBytes.length,
            revisedPrompt: generated.revisedPrompt,
          },
        };
      });
    },

    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("imagegen "));
      text += theme.fg("accent", `\"${args.path}\"`);
      if (args.quality) {
        text += theme.fg("dim", ` --quality ${args.quality}`);
      }
      if (args.size) {
        text += theme.fg("dim", ` --size ${args.size}`);
      }
      return new Text(text, 0, 0);
    },

    renderResult(result, { isPartial, expanded }, theme) {
      const details = result.details;
      if (isPartial) {
        return new Text(theme.fg("warning", "Generating image..."), 0, 0);
      }
      if (!details) {
        return new Text(theme.fg("error", "Image generation failed"), 0, 0);
      }

      let text = theme.fg(
        "success",
        `✓ Generated ${details.path} (${formatSize(details.bytes)})`,
      );
      if (expanded) {
        text += `\n${theme.fg("dim", `Model: ${details.model}`)}`;
        text += `\n${theme.fg("dim", `Size: ${details.size}`)}`;
        text += `\n${theme.fg("dim", `Quality: ${details.quality}`)}`;
        if (details.revisedPrompt) {
          text += `\n${theme.fg("dim", `Revised prompt: ${details.revisedPrompt}`)}`;
        }
      }
      return new Text(text, 0, 0);
    },
  });
}
