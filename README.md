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

## YouTube cookies (if the Android-client workaround stops working)

YouTube's bot detection is a moving target — the `player_client` trick
above can stop working without warning (this happened once already). The
next-tier fix is providing real cookies from a logged-in YouTube account.

**Real tradeoff, not a free lunch**: this ties the tool to an actual
account (yours or a parent's, never a fake one), and heavy automated use
carries a real, if small, risk of that account getting rate-limited or
challenged. Only set this up if the client-spoofing trick has actually
stopped working, not preemptively.

**Setup — use Render's Secret Files, not an environment variable.** A
base64-encoded cookies file is often too large to pass through env vars
during the build step and can cause an "argument list too long" build
failure. Secret Files avoid this entirely — they're a real file mount,
not squeezed through exec arguments.

1. Install a cookie-export browser extension:
   - Chrome: "Get cookies.txt LOCALLY" (Chrome Web Store)
   - Firefox / Zen / other Firefox-based browsers: same name, on Firefox
     Add-ons (addons.mozilla.org) — same developer, separate listing.
2. Log into youtube.com normally with a real account (yours or a
   parent's).
3. Use the extension to export cookies **for youtube.com specifically**
   (not "all cookies" — keep the file small and scoped) as a
   Netscape-format `cookies.txt` file.
4. On Render: go to the `video-watch-mcp` service → **Environment** tab →
   scroll to **Secret Files** → Add Secret File.
   - Filename: `cookies.txt`
   - Contents: paste the raw contents of the exported file — no
     base64 encoding needed, it's a real file, not an env var.
5. Save — this redeploys automatically. No `YT_COOKIES_B64` env var
   needed; the server checks `/etc/secrets/cookies.txt` first
   automatically.

**Cookies expire** — typically weeks to a couple months. When YouTube
access breaks again despite this being set up, that's usually why:
re-export fresh cookies and re-paste them into the same Secret File.

(A `YT_COOKIES_B64` env var still works as a fallback if Secret Files
aren't available for some reason, but Secret Files is the recommended
path — it's what avoids the build error in the first place.)


- 10-minute video cap for videos without captions (Whisper transcription
  needs the download first); captioned videos can go a bit longer since
  captions are cheap to check before committing to a download.
- Free Render tier sleeps after ~15 min idle — first request after that
  takes longer while it wakes and processes.
- Frame count is capped (~16 body frames + up to 15 hook frames) to keep
  the response a reasonable size for Claude to actually read.
