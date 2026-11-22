# voice-to-figma — Session Notes

Voice-controlled Figma design loop. Say "Hey Figma, …" and Claude executes design commands against the open Figma Desktop file via `figma-cli` daemon.

## Stack

```
Mic (AMD Array)
  → ffmpeg (dshow, 20dB boost, 16kHz mono s16le)
  → energy VAD (threshold = max(noiseFloor * 8, 0.05), min utterance 800ms)
  → Groq Whisper-Large-v3-Turbo (cloud, ~300-500ms)
  → Claude Sonnet 4.6 (with prompt caching)
  → figma-cli tools (figma_eval, figma_render, figma_tokens, …)
  → daemon HTTP :3456 (X-Daemon-Token auth)
  → Figma plugin (safe mode) / CDP
  → SAPI confirms via PowerShell
```

## Entry points

```powershell
# 1. Start daemon (idle-times-out after 1h)
figma-cli daemon start

# 2. Connect to Figma Desktop (needs Figma open w/ file)
figma-cli connect

# 3. Start voice loop
cd C:\Users\tn\voice-to-figma
figma-voice
```

Preflight: `figma-voice --preflight`

## Config (`.env`)

Critical vars this project depends on:
- `ANTHROPIC_API_KEY` — Claude key
- `GROQ_API_KEY` — enables cloud whisper (overrides local)
- `MIC_DEVICE=Microphone Array (AMD Audio Device)` — must be the *full name* (not an index number)
- `WHISPER_MODEL=ggml-small.en-q5_1.bin` — local fallback (only used if GROQ_API_KEY absent)
- `MODEL_EXECUTOR=claude-haiku-4-5-20251001` — fast default
- `MODEL_SMART=claude-sonnet-4-6` — used when user says "think harder", "use sonnet", "complex", "dashboard", "design system"
- Model routing lives in `pickModel()` — edit the regex to add/remove upgrade keywords
- `VAD_SILENCE_MS=400` — how long of quiet before utterance ends
- `FIGMA_CLI_PATH=C:\Users\tn\figma-cli`

## Voice vocabulary

- **Wake:** `hey figma, <command>`
- **Stop the loop:** "thank you figma" / "bye figma" / "stop figma" / "that's it figma"
- **Switch design system:** `hey figma, use Linear — make a surface-2 card`
- **Load preset tokens:** `hey figma, load Tailwind tokens`

## Design systems in this Figma file

- `shadcn/primitives` — 244 vars (Shadcn default)
- `Linear` — 22 vars (16 colors + 6 radii; indigo primary, surface-1..4 blacks)

Switch between them by naming the system in the command. Both coexist.

### Add another design system

```powershell
figma-cli import "tokens.json" --collection "YourName"
# also accepts: tailwind.config.js, globals.css, DESIGN.md, Storybook URL
```

W3C tokens JSON template is at `linear-tokens.json`.

## Bugs we hit + fixes (DO NOT REGRESS)

1. **`.env` must live in project dir** not `C:\Users\tn\`. The npm global copy at `AppData\Roaming\npm\node_modules\voice-to-figma\` is NOT what runs — the local `C:\Users\tn\voice-to-figma\` is.

2. **`MIC_DEVICE=0` does NOT work.** ffmpeg needs the full device name: `Microphone Array (AMD Audio Device)`.

3. **Daemon endpoint is `/health` not `/status`.** `daemonPing()` in `voice.mjs` was fixed to use `/health` + `X-Daemon-Token` header.

4. **AMD mic array outputs near-silent signal.** Peak RMS ~0.0004 unamplified. Fix: `-af volume=20dB` in ffmpeg command. Also tried raw mic volume to 100% via Windows Audio API (`AudioHelper.SetMicVolume(1.0)`) — helps a bit.

5. **VAD false triggers → Groq rate limit (20 req/min).** Fixed by raising threshold to `max(noiseFloor * 8, 0.05)` and minimum utterance from 300ms → 800ms.

6. **Windows Speech Recognition path abandoned.** System only has `de-DE` recognizer installed. English pack requires admin install via Settings → Time & Language → Language → English (US) → Speech. Code still has `win-stt.ps1` scaffolding if we ever want to revive.

7. **Prompt caching enabled.** `cache_control: { type: 'ephemeral' }` added to last system block + last tool. Cuts 1–2s off every call after the first.

8. **`max_tokens: 4096 → 1024`.** Voice commands never need 4096.

9. **`figma-cli connect` does NOT start the daemon.** They're separate. Daemon must be started first, then `connect` establishes the CDP/plugin link.

## Files in this project

- `voice.mjs` — main loop (ffmpeg → VAD → Groq → Claude → daemon)
- `win-stt.ps1` — Windows Speech Recognition helper (unused, needs English pack)
- `linear-design.md` / `linear-tokens.json` — Linear design system reference + importable tokens
- `.env` — runtime config
- `bin/` — whisper.cpp binaries + small model (fallback when Groq unavailable)

## Open ideas

- Auto-route simple commands ("make a circle") to Haiku, complex intent to Sonnet
- Voice hotword "undo" → `figma.commitUndo()`
- Figma selection context — read current selection into system prompt before each call
- Streaming Groq (partial transcripts for faster UX)
