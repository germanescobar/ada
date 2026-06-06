import fs from "node:fs/promises";
import path from "node:path";
import type { ModelCapabilities } from "./models/resolve.js";
import type { AttachmentContentBlock, AttachmentSource } from "./types/messages.js";

const IMAGE_MEDIA_TYPES = new Map<string, string>([
  [".gif", "image/gif"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".png", "image/png"],
  [".webp", "image/webp"],
]);
const PDF_MEDIA_TYPE = "application/pdf";

export async function loadAttachments(
  inputs: string[],
  capabilities: ModelCapabilities,
  cwd: string
): Promise<AttachmentContentBlock[]> {
  if (inputs.length === 0) return [];

  const attachmentCapabilities = capabilities.attachments;
  if (!attachmentCapabilities) {
    throw new Error("The selected model does not support attachments.");
  }

  const attachments: AttachmentContentBlock[] = [];
  for (const input of inputs) {
    const attachment = await loadAttachment(input, cwd);
    if (attachment.type === "image" && !attachmentCapabilities.images) {
      throw new Error(
        `The selected model does not support image attachments: ${input}`
      );
    }
    if (attachment.type === "file" && !attachmentCapabilities.files) {
      throw new Error(
        `The selected model does not support file attachments: ${input}`
      );
    }
    attachments.push(attachment);
  }

  return attachments;
}

async function loadAttachment(
  input: string,
  cwd: string
): Promise<AttachmentContentBlock> {
  const name = path.basename(input);
  const mediaType = mediaTypeFromPath(input);

  if (!mediaType) {
    throw new Error(
      `Unsupported attachment type: ${input}. Supported: png, jpg, jpeg, webp, gif, pdf.`
    );
  }

  const source = isHttpUrl(input)
    ? urlSource(input)
    : await dataSource(path.resolve(cwd, input), mediaType);

  if (mediaType === PDF_MEDIA_TYPE) {
    return { type: "file", name, mediaType, source };
  }

  return { type: "image", name, source };
}

function mediaTypeFromPath(input: string): string | undefined {
  const extension = path.extname(urlPathname(input)).toLowerCase();
  return IMAGE_MEDIA_TYPES.get(extension) ?? (extension === ".pdf" ? PDF_MEDIA_TYPE : undefined);
}

function urlPathname(input: string): string {
  if (!isHttpUrl(input)) return input;
  return new URL(input).pathname;
}

function isHttpUrl(input: string): boolean {
  try {
    const url = new URL(input);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function urlSource(url: string): AttachmentSource {
  return { type: "url", url };
}

async function dataSource(
  filePath: string,
  mediaType: string
): Promise<AttachmentSource> {
  const bytes = await fs.readFile(filePath);
  return {
    type: "data",
    mediaType,
    data: bytes.toString("base64"),
  };
}
