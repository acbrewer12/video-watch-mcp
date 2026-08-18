# Video-Watch MCP (remote, works from mobile)

Lets Claude actually *see* a video — sampled frames plus its transcript,
timestamp-aligned — from any device, not just Claude Code on a desktop.

**Transcription**: uses YouTube captions when available, and falls back to
Groq's free Whisper API (no card, ~2,000 min/day free, whisper-large-v3)
for videos without captions — so unlike the local `claude-watch` skill,
this works on essentially any video, not just captioned ones.

## Deploy (free, no card)

1. New repo on GitHub, push these 4 files (`server.js`, `package.json`,
   `Dockerfile`, this `README.md`).
2. Get a free Groq API key at console.groq.com (no card).
3. Render.com → New → Web Service → connect the repo.
4. Render should detect the Dockerfile automatically (Environment: Docker).
   Plan: **Free**.
5. Environment variables: `MCP_AUTH_TOKEN` (random string) and
   `GROQ_API_KEY` (from step 2).
6. Deploy. First build takes a few minutes (installing ffmpeg + yt-dlp).

## Connect it in Claude

Settings → Connectors → Add custom connector:
- URL: `https://<your-app>.onrender.com/mcp`

## Limits (free tier reality)

- 10-minute video cap for videos without captions (Whisper transcription
  needs the download first); captioned videos can go a bit longer since
  captions are cheap to check before committing to a download.
- Free Render tier sleeps after ~15 min idle — first request after that
  takes longer while it wakes and processes.
- Frame count is capped (~16 body frames + up to 15 hook frames) to keep
  the response a reasonable size for Claude to actually read.
