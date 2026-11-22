# Figma-Abracadabra

> *"Hey Figma, build a pricing card with three tiers."*

Windows voice loop for [figma-cli](https://github.com/silships/figma-cli). Say a design command out loud and watch the component appear in Figma Desktop. No keyboard, no clicking.

## How it works

```
mic → ffmpeg (+20dB boost) → energy VAD
     → Groq Whisper-Large-v3 (cloud, ~500ms)
     → Claude (Haiku 4.5 default, Sonnet on request)
     → figma-cli daemon → Figma Desktop
     → PowerShell SAPI confirms "okay"
```

Two modes:

- **`--mode call`** *(default)* — only reacts after the wake phrase `"Hey Figma, …"`. Safe during Zoom calls.
- **`--mode studio`** — classifies every utterance with Haiku. Hands-free solo work.

## One-time setup (Windows)

### 1. Prereqs

- Node.js 20+ — [nodejs.org](https://nodejs.org)
- Figma Desktop installed
- [figma-cli](https://github.com/silships/figma-cli) installed locally
- An Anthropic API key — [console.anthropic.com](https://console.anthropic.com)
- (Optional, recommended) A Groq API key — free at [console.groq.com](https://console.groq.com/keys). Switches transcription from local whisper (~3s on CPU) to cloud (~500ms).

### 2. Install ffmpeg

```powershell
winget install Gyan.FFmpeg
```

Reopen the terminal, then `ffmpeg -version` should print.

### 3. Download whisper.cpp + model (only needed if NOT using Groq)

Create `bin/` and drop in:

- `whisper.exe` from [whisper.cpp releases](https://github.com/ggerganov/whisper.cpp/releases) (`whisper-blas-bin-x64.zip`)
- `ggml-small.en-q5_1.bin` from [Hugging Face](https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en-q5_1.bin)

### 4. Clone + install

```powershell
git clone https://github.com/juancodez/Figma-Abracadabra.git
cd Figma-Abracadabra
npm install
npm link     # registers `figma-voice` on your PATH
```

### 5. Configure

```powershell
copy .env.example .env
notepad .env   # paste ANTHROPIC_API_KEY, optionally GROQ_API_KEY, MIC_DEVICE
```

### 6. Start the daemon + connect Figma

```powershell
figma-cli daemon start    # starts the HTTP daemon on :3456
figma-cli connect         # connects to Figma Desktop (keep the file open)
```

### 7. Preflight + run

```powershell
figma-voice --preflight    # expect: Preflight OK
figma-voice                # listens for "Hey Figma, …"
```

### 8. Speak

> **"Hey Figma, make a surface-2 card with a primary button."**
> **"Hey Figma, use Linear — create a pricing card."**
> **"Hey Figma, think harder — build a full dashboard with sidebar and stat cards."**
> **"Thank you Figma."** *(exits the loop)*

Component appears in Figma within 2–4 seconds. SAPI voice confirms "okay".

## Design systems

Multiple design systems coexist as Figma variable collections. Switch between them by name in the voice command:

```
"Hey Figma, use Linear — make a primary button"
"Hey Figma, use shadcn — make a secondary button"
```

To import a new one:

```powershell
figma-cli import "tokens.json" --collection "YourName"
# also accepts: tailwind.config.js, globals.css, DESIGN.md, Storybook URL
```

Reference W3C tokens JSON in `linear-tokens.json`.

## Stop phrases

Exit the loop by voice:

- *"Thank you Figma"* / *"Thanks Figma"*
- *"Bye Figma"* / *"Goodbye Figma"*
- *"Stop Figma"* / *"That's it Figma"*

## Config (.env)

| Var | Default | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | Required |
| `GROQ_API_KEY` | *(optional)* | Enables cloud whisper; much faster + more accurate |
| `FIGMA_CLI_PATH` | — | Install dir of figma-cli |
| `MODE` | `call` | `call` or `studio` |
| `WAKE` | `hey figma` | Wake phrase for call mode |
| `MIC_DEVICE` | *(prompt)* | ffmpeg dshow device name — full name, not an index |
| `WHISPER_MODEL` | `ggml-small.en-q5_1.bin` | Local fallback when Groq is absent |
| `MODEL_EXECUTOR` | `claude-haiku-4-5-20251001` | Fast default |
| `MODEL_SMART` | `claude-sonnet-4-6` | Used when you say *"think harder"*, *"complex"*, *"dashboard"*, etc. |
| `VAD_SILENCE_MS` | `1200` | Silence after speech before emitting utterance — raise if you pause mid-sentence |
| `CALL_WINDOW_MS` | `10000` | Follow-up window after a wake-phrase hit |

## Troubleshooting

- **AMD / Realtek mic captures silence** → `-af volume=20dB` in ffmpeg already active. Also confirm Windows mic volume is 100% in Sound Settings.
- **Groq 429 rate-limit** → free tier is 20 req/min. Raise VAD threshold / minimum utterance length to reduce false triggers.
- **Daemon idle-timed out** → `figma-cli daemon start` again. It auto-shuts down after 1h idle.
- **`mode: safe` vs `mode: yolo`** → safe uses a Figma plugin (no patching). Yolo patches Figma for CDP (more power). Toggle via `figma-cli connect` / `figma-cli connect --safe`.
- **Not recognizing your voice well** → change `whisper-large-v3-turbo` to `whisper-large-v3` in `voice.mjs` for maximum accuracy.

## Credits

- [figma-cli](https://github.com/silships/figma-cli) by Sil Bormüller — reused as-is for the Figma side.
- [whisper.cpp](https://github.com/ggerganov/whisper.cpp) by Georgi Gerganov — local speech-to-text.
- [Groq](https://groq.com) — cloud whisper inference.

## License

MIT — see [LICENSE](LICENSE).
