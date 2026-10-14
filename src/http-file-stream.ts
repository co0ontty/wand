import { exec } from "node:child_process";
import { createReadStream } from "node:fs";
import type { Request, Response } from "express";
import { getErrorMessage } from "./error-utils.js";

/** HTTP file responses with Range support, shared by file, update and download routes. */
export function streamFileWithRange(
  req: Request,
  res: Response,
  options: {
    filePath: string;
    size: number;
    contentType: string;
    disposition?: string;
    headers?: Record<string, string>;
    readErrorMessage?: string;
  },
): void {
  res.setHeader("Content-Type", options.contentType);
  if (options.disposition) res.setHeader("Content-Disposition", options.disposition);
  for (const [name, value] of Object.entries(options.headers ?? {})) res.setHeader(name, value);
  res.setHeader("Accept-Ranges", "bytes");
  if (options.size === 0) {
    if (req.headers.range?.trim().startsWith("bytes=")) {
      res.status(416).setHeader("Content-Range", "bytes */0").end();
      return;
    }
    res.setHeader("Content-Length", "0");
    res.end();
    return;
  }
  const parsedRange = parseByteRange(req.headers.range, options.size);
  if (parsedRange === "invalid") {
    res.status(416).setHeader("Content-Range", `bytes */${options.size}`).end();
    return;
  }
  const start = parsedRange?.start ?? 0;
  const end = parsedRange?.end ?? options.size - 1;
  if (parsedRange) {
    res.status(206);
    res.setHeader("Content-Range", `bytes ${start}-${end}/${options.size}`);
  }
  res.setHeader("Content-Length", String(end - start + 1));
  const stream = createReadStream(options.filePath, { start, end });
  stream.on("error", (error) => {
    if (!res.headersSent) {
      res.status(500).json({ error: getErrorMessage(error, options.readErrorMessage ?? "读取文件失败。") });
    } else {
      res.destroy();
    }
  });
  stream.pipe(res);
}

interface ParsedByteRange {
  start: number;
  end: number;
}

function parseByteRange(rangeHeader: string | undefined, total: number): ParsedByteRange | "invalid" | null {
  if (!rangeHeader) return null;
  const trimmed = rangeHeader.trim();
  if (!trimmed.startsWith("bytes=")) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(trimmed);
  if (!match || (match[1] === "" && match[2] === "")) return "invalid";
  let start: number;
  let end: number;
  if (match[1] === "") {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return "invalid";
    start = Math.max(0, total - suffixLength);
    end = total - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === "" ? total - 1 : Math.min(Number(match[2]), total - 1);
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= total) {
    return "invalid";
  }
  return { start, end };
}
