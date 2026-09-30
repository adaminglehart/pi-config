import { resizeImage } from "@earendil-works/pi-coding-agent";

const decoder = new TextDecoder("ascii");

/** Only these byte signatures can be sent as provider image blocks. */
function imageMime(bytes: Uint8Array): string | undefined {
  if (bytes.length >= 8 &&
      bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e &&
      bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a &&
      bytes[6] === 0x1a && bytes[7] === 0x0a) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 6 && ["GIF87a", "GIF89a"].includes(decoder.decode(bytes.subarray(0, 6)))) return "image/gif";
  if (bytes.length >= 12 && decoder.decode(bytes.subarray(0, 4)) === "RIFF" &&
      decoder.decode(bytes.subarray(8, 12)) === "WEBP") return "image/webp";
  return undefined;
}

/** Verify bytes, dimensions, and base64 size before they reach the model. */
export async function safeImageContent(
  bytes: Uint8Array,
): Promise<{ data: string; mimeType: string } | null> {
  const mime = imageMime(bytes);
  if (!mime) return null;
  const result = await resizeImage(bytes, mime);
  return result ? { data: result.data, mimeType: result.mimeType } : null;
}
