import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import path from "path";
import os from "os";

const execFileAsync = promisify(execFile);

const AUTH_TOKEN = process.env.MCP_AUTH_TOKEN; // optional — see note below
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const MAX_DURATION_SECONDS = 600; // 10 min cap, keeps this workable on a free instance
const MAX_BODY_FRAMES = 16;

if (!GROQ_API_KEY) {
  console.error("Missing required env var: GROQ_API_KEY (free key from console.groq.com)");
  process.exit(1);
}

async function transcribeWithGroq(audioPath) {
  const audioBuffer = await fs.readFile(audioPath);
  const form = new FormData();
  form.append("file", new Blob([audioBuffer]), "audio.wav");
  form.append("model", "whisper-large-v3");
  form.append("response_format", "verbose_json");

  const res = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${GROQ_API_KEY}` },
    body: form,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Groq transcription failed (${res.status}): ${text.slice(0, 300)}`);
  }
  const data = await res.json();
  if (Array.isArray(data.segments) && data.segments.length) {
    return data.segments.map((seg) => ({ start: seg.start, text: seg.text.trim() }));
  }
  return data.text ? [{ start: 0, text: data.text }] : [];
}

async function run(cmd, args, opts = {}) {
  return execFileAsync(cmd, args, { maxBuffer: 1024 * 1024 * 50, ...opts });
}

// YouTube's web client gets heavily bot-checked on datacenter IPs (which is
// what a Render/cloud server has). Its Android client API faces much lighter
// checks and needs no cookies/login — the standard free workaround. Falls
// back to web/ios if Android alone doesn't have the needed format.
const YT_CLIENT_ARGS = ["--extractor-args", "youtube:player_client=android,web,ios"];
const YT_COOKIES_SECRET_PATH = "/etc/secrets/cookies.txt"; // Render Secret Files
const YT_COOKIES_B64 = process.env.YT_COOKIES_B64; // fallback — see README, avoid if possible
let cookiesFilePath = null;
let cookiesChecked = false;

async function ensureCookiesFile() {
  if (cookiesChecked) return cookiesFilePath;
  cookiesChecked = true;

  // Prefer Render's Secret Files — a real file mount, not squeezed through
  // an env var. Large base64 env vars can blow past the exec argument-list
  // limit during the build step ("argument list too long").
  try {
    await fs.access(YT_COOKIES_SECRET_PATH);
    cookiesFilePath = YT_COOKIES_SECRET_PATH;
    return cookiesFilePath;
  } catch {
    // not present, fall through
  }

  if (YT_COOKIES_B64) {
    const filePath = path.join(os.tmpdir(), "yt-cookies.txt");
    await fs.writeFile(filePath, Buffer.from(YT_COOKIES_B64, "base64").toString("utf-8"));
    cookiesFilePath = filePath;
  }
  return cookiesFilePath;
}

async function ytdlp(args) {
  const cookies = await ensureCookiesFile();
  const cookieArgs = cookies ? ["--cookies", cookies] : [];
  return run("yt-dlp", [...YT_CLIENT_ARGS, ...cookieArgs, ...args]);
}

function parseVtt(vttText) {
  // Returns structured segments: [{ start: seconds, text }]
  const lines = vttText.split("\n");
  const segments = [];
  let lastStart = null;
  for (const line of lines) {
    const timeMatch = line.match(/^(\d{2}):(\d{2}):(\d{2})\.\d+\s+-->/);
    if (timeMatch) {
      const [, hh, mm, ss] = timeMatch;
      lastStart = parseInt(hh, 10) * 3600 + parseInt(mm, 10) * 60 + parseInt(ss, 10);
      continue;
    }
    const clean = line.replace(/<[^>]+>/g, "").trim();
    if (!clean || clean === "WEBVTT" || /^\d+$/.test(clean)) continue;
    if (lastStart !== null) {
      segments.push({ start: lastStart, text: clean });
      lastStart = null;
    } else if (segments.length) {
      segments[segments.length - 1].text += ` ${clean}`;
    }
  }
  return segments;
}

function formatSeg(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function formatTranscript(segments) {
  return segments.map((s) => `[${formatSeg(s.start)}] ${s.text}`).join("\n");
}

// Finds the transcript segment active at (or just before) a given time.
function transcriptAt(segments, time) {
  let best = null;
  for (const seg of segments) {
    if (seg.start <= time) best = seg;
    else break;
  }
  return best ? best.text : "(no dialogue yet)";
}

async function watchVideo(url) {
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "watch-"));
  try {
    // 1. Check for captions first — cheap, and tells us early if this video
    // is even usable without needing full audio transcription.
    await ytdlp([
      "--skip-download",
      "--write-auto-sub",
      "--write-sub",
      "--sub-lang", "en",
      "--sub-format", "vtt",
      "-o", path.join(workDir, "captions"),
      url,
    ]).catch(() => {});

    const files = await fs.readdir(workDir);
    const vttFile = files.find((f) => f.endsWith(".vtt"));

    // Duration + metadata check up front, before downloading anything heavy.
    const { stdout: metaStr } = await ytdlp([
      "--print", "%(duration)s\n%(title)s\n%(uploader)s\n%(description)s",
      url,
    ]);
    const [durLine, titleLine, uploaderLine, ...descLines] = metaStr.split("\n");
    const duration = parseFloat(durLine.trim());
    const title = (titleLine || "").trim();
    const uploader = (uploaderLine || "").trim();
    const description = descLines.join("\n").trim();
    if (duration && duration > MAX_DURATION_SECONDS && !vttFile) {
      return {
        content: [{ type: "text", text: `This video is ${Math.round(duration / 60)} minutes and has no captions — too long to transcribe on this server's free tier (cap is ${MAX_DURATION_SECONDS / 60} min).` }],
        isError: true,
      };
    }

    // Download once, at a capped resolution, regardless of which transcript path we take.
    const videoPath = path.join(workDir, "video.mp4");
    await ytdlp(["-o", videoPath, "-f", "mp4[height<=480]/mp4", url]);

    let segments;
    if (vttFile) {
      const vttText = await fs.readFile(path.join(workDir, vttFile), "utf-8");
      segments = parseVtt(vttText);
    } else {
      // No captions — fall back to Groq's free Whisper API instead of giving up.
      const audioPath = path.join(workDir, "audio.wav");
      await run("ffmpeg", ["-y", "-i", videoPath, "-ar", "16000", "-ac", "1", audioPath]);
      segments = await transcribeWithGroq(audioPath);
    }
    const transcript = formatTranscript(segments);

    if (duration && duration > MAX_DURATION_SECONDS) {
      // Had captions, so we got this far, but still too long for frame sampling.
      return {
        content: [{ type: "text", text: `This video is ${Math.round(duration / 60)} minutes — longer than the ${MAX_DURATION_SECONDS / 60}-minute cap, so here's the transcript only:\n\n${transcript}` }],
      };
    }
    // Frame sampling — tiled into a couple of contact-sheet images instead of
    // many separate ones. One image with a grid of thumbnails costs far fewer
    // tokens than the same frames sent as N individual images.
    const sheetsDir = path.join(workDir, "sheets");
    await fs.mkdir(sheetsDir);

    const hookSheetPath = path.join(sheetsDir, "hook_sheet.jpg");
    await run("ffmpeg", [
      "-y", "-t", "15", "-i", videoPath,
      "-vf", "fps=1,scale=180:-1,tile=5x3:margin=4:padding=2:color=white",
      hookSheetPath,
    ]);

    const bodyInterval = Math.max(3.5, (duration || 60) / MAX_BODY_FRAMES);
    const bodySheetPath = path.join(sheetsDir, "body_sheet.jpg");
    await run("ffmpeg", [
      "-y", "-i", videoPath,
      "-vf", `fps=1/${bodyInterval},scale=180:-1,tile=4x4:margin=4:padding=2:color=white`,
      bodySheetPath,
    ]);

    // Build a text index mapping each grid cell to its approximate time AND
    // the transcript line active at that moment — so Claude doesn't have to
    // guess which cell lines up with what's being said.
    const hookIndex = [];
    for (let i = 0; i < 15; i++) {
      hookIndex.push(`  cell ${i + 1} (~${i}s): "${transcriptAt(segments, i)}"`);
    }
    const bodyIndex = [];
    for (let i = 0; i < MAX_BODY_FRAMES; i++) {
      const t = Math.round(15 + i * bodyInterval);
      bodyIndex.push(`  cell ${i + 1} (~${t}s): "${transcriptAt(segments, t)}"`);
    }

    const content = [
      { type: "text", text: `Title: ${title}\nChannel/Uploader: ${uploader}\n\nDescription:\n${description || "(no description provided)"}` },
      { type: "text", text: `Transcript:\n\n${transcript}` },
      {
        type: "text",
        text: `Hook sheet index — 5 cols x 3 rows, left-to-right then top-to-bottom, one frame/second for the first 15s. What's being said at each frame:\n${hookIndex.join("\n")}`,
      },
      {
        type: "text",
        text: "Hook sheet image (matches the index above):",
      },
    ];
    const hookData = await fs.readFile(hookSheetPath);
    content.push({ type: "image", data: hookData.toString("base64"), mimeType: "image/jpeg" });

    content.push({
      type: "text",
      text: `Body sheet index — 4 cols x 4 rows, left-to-right then top-to-bottom, one frame every ~${Math.round(bodyInterval)}s starting at ~15s. What's being said at each frame:\n${bodyIndex.join("\n")}`,
    });
    content.push({ type: "text", text: "Body sheet image (matches the index above):" });
    const bodyData = await fs.readFile(bodySheetPath);
    content.push({ type: "image", data: bodyData.toString("base64"), mimeType: "image/jpeg" });

    return { content };
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

function buildServer() {
  const server = new McpServer({ name: "video-watch", version: "1.0.0" });

  server.tool(
    "watch_video",
    "Download a video (YouTube, and other yt-dlp-supported sites), get its title/uploader/description plus a transcript (captions if available, otherwise free Groq Whisper transcription), and see it via two tiled contact-sheet images (first 15s, and the rest) — each accompanied by a text index mapping every grid cell to its timestamp and the transcript line spoken at that moment, so frames and dialogue line up without guessing. Videos over 10 minutes without captions get transcript-only.",
    { url: z.string().describe("URL of the video to watch") },
    async ({ url }) => {
      try {
        return await watchVideo(url);
      } catch (err) {
        return { content: [{ type: "text", text: `Error watching video: ${err.message}` }], isError: true };
      }
    }
  );

  return server;
}

const app = express();
app.use(express.json({ limit: "10mb" }));

app.get("/", (_req, res) => res.send("Video-watch MCP server is running."));

app.use((req, res, next) => {
  if (req.path === "/") return next();
  // Auth is optional: claude.ai's connector UI has no field for a custom
  // header, so enforcing a token here makes every connection attempt from
  // Claude fail with a 401 and get misread as an OAuth requirement. If
  // MCP_AUTH_TOKEN is set, it's still checked (useful for non-Claude
  // clients that can send headers) — but Claude itself connects unauthed,
  // relying on the URL being unguessable.
  if (AUTH_TOKEN) {
    const auth = req.headers.authorization || "";
    if (auth !== `Bearer ${AUTH_TOKEN}`) {
      return res.status(401).json({ error: "Unauthorized" });
    }
  }
  next();
});

app.post("/mcp", async (req, res) => {
  try {
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => transport.close());
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("MCP request error:", err);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
    }
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Video-watch MCP server listening on port ${PORT}`);
});
