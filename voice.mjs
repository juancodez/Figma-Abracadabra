#!/usr/bin/env node
/**
 * voice-to-figma — Windows voice loop for figma-cli.
 *
 * Flow: ffmpeg (continuous mic) -> energy VAD -> whisper.cpp -> mode gate
 *       -> Anthropic streaming (figma-cli tools) -> daemon exec / subprocess
 *       -> Figma Desktop renders -> PowerShell SAPI confirms.
 *
 * Reuses figma-cli's prompt.js + tools/figma-tools.json (read-only, no fork).
 */

import 'dotenv/config';
import { spawn, execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { createInterface } from 'node:readline';

// ───────────── env + constants ─────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIGMA_CLI = process.env.FIGMA_CLI_PATH || 'C:\\Users\\tn\\figma-cli';
const API_KEY = process.env.ANTHROPIC_API_KEY;
const MODE_DEFAULT = process.env.MODE || 'call';
const WAKE = (process.env.WAKE || 'hey figma').toLowerCase();
const WHISPER_BIN = resolve(__dirname, 'bin', process.env.WHISPER_BIN || 'whisper.exe');
const WHISPER_MODEL = resolve(__dirname, 'bin', process.env.WHISPER_MODEL || 'ggml-small.en-q5_1.bin');
const MIC_DEVICE = process.env.MIC_DEVICE || '';
const MODEL_EXECUTOR = process.env.MODEL_EXECUTOR || 'claude-haiku-4-5-20251001';
const MODEL_SMART = process.env.MODEL_SMART || 'claude-sonnet-4-6';
const MODEL_GATE = process.env.MODEL_GATE || 'claude-haiku-4-5-20251001';

function pickModel(cmd) {
  const smartRe = /\b(think harder|use sonnet|complex|carefully|thoroughly|dashboard|whole page|full page|design system)\b/i;
  return smartRe.test(cmd) ? MODEL_SMART : MODEL_EXECUTOR;
}
const VAD_SILENCE_MS = Number(process.env.VAD_SILENCE_MS || 600);
const CALL_WINDOW_MS = Number(process.env.CALL_WINDOW_MS || 10000);
const SAMPLE_RATE = 16000;
const DAEMON_PORT = 3456;
const DAEMON_TOKEN_FILE = join(homedir(), '.figma-ds-cli', '.daemon-token');

// ───────────── argv ─────────────

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  if (i === -1) return null;
  const next = argv[i + 1];
  return next && !next.startsWith('--') ? next : true;
};
const MODE = flag('--mode') || MODE_DEFAULT;
const PREFLIGHT_ONLY = flag('--preflight') === true;
const LIST_DEVICES = flag('--list-devices') === true;

// ───────────── tiny helpers ─────────────

const log = (...a) => console.log('·', ...a);
const warn = (...a) => console.error('! ', ...a);
const die = (msg) => { console.error('✗', msg); process.exit(1); };

function sh(cmd, args, opts = {}) {
  return new Promise((res, rej) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
    let stdout = '', stderr = '';
    child.stdout?.on('data', d => stdout += d.toString());
    child.stderr?.on('data', d => stderr += d.toString());
    child.on('close', code => res({ code, stdout, stderr }));
    child.on('error', rej);
  });
}

function speak(text) {
  if (!text) return;
  const clean = text.replace(/[\r\n]+/g, ' ').slice(0, 200).replace(/'/g, "''");
  spawn('powershell.exe', ['-NoProfile', '-Command',
    `Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.Rate = 1; $s.Speak('${clean}')`
  ], { stdio: 'ignore', detached: true }).unref();
}

// ───────────── preflight ─────────────

async function preflight() {
  const issues = [];
  if (!API_KEY) issues.push('ANTHROPIC_API_KEY missing in .env');
  if (!existsSync(FIGMA_CLI)) issues.push(`FIGMA_CLI_PATH does not exist: ${FIGMA_CLI}`);
  if (!existsSync(join(FIGMA_CLI, 'plugins', 'voice', 'prompt.js'))) issues.push(`Not a figma-cli install (plugins/voice/prompt.js missing): ${FIGMA_CLI}`);
  if (!existsSync(WHISPER_BIN)) issues.push(`whisper.cpp binary missing: ${WHISPER_BIN} (see README step 3)`);
  if (!existsSync(WHISPER_MODEL)) issues.push(`whisper model missing: ${WHISPER_MODEL} (see README step 3)`);

  const ff = await sh('ffmpeg', ['-version']).catch(() => ({ code: 1 }));
  if (ff.code !== 0) issues.push('ffmpeg not found on PATH (winget install Gyan.FFmpeg)');

  const daemon = await daemonPing();
  if (!daemon) issues.push('figma-cli daemon not running (run `figma-cli connect` first)');

  if (issues.length) {
    console.error('✗ Preflight failed:');
    for (const i of issues) console.error('  •', i);
    return false;
  }
  log('Preflight OK — ffmpeg, whisper, figma-cli daemon, api key.');
  return true;
}

// ───────────── figma-cli daemon bridge ─────────────

function getDaemonToken() {
  try { return readFileSync(DAEMON_TOKEN_FILE, 'utf-8').trim(); } catch { return null; }
}

async function daemonPing() {
  try {
    const token = getDaemonToken();
    const headers = {};
    if (token) headers['X-Daemon-Token'] = token;
    const res = await fetch(`http://localhost:${DAEMON_PORT}/health`, { headers, signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch { return false; }
}

async function daemonExec(action, data = {}, timeout = 60000) {
  const token = getDaemonToken();
  const headers = { 'content-type': 'application/json' };
  if (token) headers['X-Daemon-Token'] = token;
  const res = await fetch(`http://localhost:${DAEMON_PORT}/exec`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ action, ...data }),
    signal: AbortSignal.timeout(timeout),
  });
  if (!res.ok) return { ok: false, error: await res.text() };
  const result = await res.json();
  return { ok: true, stdout: typeof result === 'string' ? result : JSON.stringify(result), stderr: '' };
}

function runFigmaCli(args, { timeout = 60000 } = {}) {
  return new Promise((res, rej) => {
    const child = spawn('figma-cli', args, {
      shell: true, // resolves .cmd shim on Windows
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); rej(new Error(`timeout ${timeout}ms`)); }, timeout);
    child.stdout.on('data', d => stdout += d.toString());
    child.stderr.on('data', d => stderr += d.toString());
    child.on('close', code => { clearTimeout(timer); res({ ok: code === 0, code, stdout, stderr }); });
    child.on('error', err => { clearTimeout(timer); rej(err); });
  });
}

// ───────────── tool dispatch (mirrors Mac plugin) ─────────────

const toolHandlers = {
  async figma_render({ jsx }) { return daemonExec('render', { jsx }); },
  async figma_eval({ code }) { return daemonExec('eval', { code }); },
  async figma_verify({ node_id } = {}) { return runFigmaCli(node_id ? ['verify', node_id] : ['verify']); },
  async figma_blocks_create({ block }) { return runFigmaCli(['blocks', 'create', block]); },
  async figma_blocks_list() { return runFigmaCli(['blocks', 'list']); },
  async figma_tokens({ preset }) {
    if (preset === 'shadcn') return runFigmaCli(['tokens', 'preset', 'shadcn']);
    if (preset === 'tailwind') return runFigmaCli(['tokens', 'tailwind']);
    if (preset === 'ds') return runFigmaCli(['tokens', 'ds']);
    return { ok: false, error: `Unknown preset: ${preset}` };
  },
  async figma_a11y_audit({ node_id }) {
    return runFigmaCli(node_id ? ['a11y', 'audit', node_id] : ['a11y', 'audit'], { timeout: 120000 });
  },
  async figma_get_selection() {
    return daemonExec('eval', { code: `(() => { const sel = figma.currentPage.selection; return sel.map(n => ({ id: n.id, name: n.name, type: n.type, x: n.x, y: n.y, width: n.width, height: n.height })); })()` });
  },
  async figma_component_list() { return runFigmaCli(['component', 'list']); },
  async figma_gradient_extract({ image_path, mode, apply_to, direction, stops, blur }) {
    const args = ['gradient', 'extract', image_path];
    if (mode) args.push('--mode', mode);
    if (apply_to) args.push('--apply-to', apply_to);
    if (direction) args.push('--direction', direction);
    if (stops) args.push('--stops', String(stops));
    if (blur != null) args.push('--blur', String(blur));
    args.push('--json');
    return runFigmaCli(args);
  },
  async figma_gradient_mesh({ colors, style, seed, apply_to, size, base, blur, name }) {
    const args = ['gradient', 'mesh', colors];
    if (style) args.push('--style', style);
    if (seed != null) args.push('--seed', String(seed));
    if (apply_to) args.push('--apply-to', apply_to);
    if (size) args.push('--size', size);
    if (base) args.push('--base', base);
    if (blur != null) args.push('--blur', String(blur));
    if (name) args.push('--name', name);
    args.push('--json');
    return runFigmaCli(args);
  },
};

async function dispatchTool(name, input) {
  const h = toolHandlers[name];
  if (!h) return { ok: false, error: `Unknown tool: ${name}` };
  try { return await h(input || {}); } catch (err) { return { ok: false, error: err.message }; }
}

// ───────────── system prompt (reuse figma-cli's own) ─────────────

async function buildSystemPrompt() {
  // dynamic-import prompt.js from installed figma-cli. Its findFigmaCliDocs()
  // reads FIGMA_CLI_PATH env var, which we already set.
  process.env.FIGMA_CLI_PATH = FIGMA_CLI;
  const promptUrl = pathToFileURL(join(FIGMA_CLI, 'plugins', 'voice', 'prompt.js')).href;
  const { buildSystemPrompt: build } = await import(promptUrl);
  const blocks = build();

  // Append local design-system.md if present in cwd.
  const dsPath = resolve(process.cwd(), 'design-system.md');
  if (existsSync(dsPath)) {
    blocks.push({
      type: 'text',
      text: `=== Project design system (./design-system.md) ===\n${readFileSync(dsPath, 'utf-8')}`,
    });
    log(`Loaded ./design-system.md (${process.cwd()})`);
  }
  return blocks;
}

function loadTools() {
  return JSON.parse(readFileSync(join(FIGMA_CLI, 'plugins', 'voice', 'tools', 'figma-tools.json'), 'utf-8'));
}

// ───────────── Anthropic streaming (ported from Mac plugin) ─────────────

async function callAnthropicStream(messages, system, tools, model, { onText } = {}) {
  // Add cache_control to the last system block + last tool so Anthropic caches
  // the static prefix — subsequent calls hit the cache (~90% faster TTFB).
  const sys = Array.isArray(system) && system.length
    ? system.map((b, i) => i === system.length - 1 ? { ...b, cache_control: { type: 'ephemeral' } } : b)
    : system;
  const tls = Array.isArray(tools) && tools.length
    ? tools.map((t, i) => i === tools.length - 1 ? { ...t, cache_control: { type: 'ephemeral' } } : t)
    : tools;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ model, max_tokens: 1024, stream: true, system: sys, tools: tls, messages }),
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`);

  const content = [];
  let current = null;
  let stopReason = null;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() || '';
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6);
      if (data === '[DONE]') continue;
      let e;
      try { e = JSON.parse(data); } catch { continue; }
      if (e.type === 'content_block_start') {
        current = { ...e.content_block };
        if (current.type === 'text') current.text = '';
        if (current.type === 'tool_use') current.input = '';
      } else if (e.type === 'content_block_delta' && current) {
        if (e.delta.type === 'text_delta') { current.text += e.delta.text; onText?.(e.delta.text); }
        else if (e.delta.type === 'input_json_delta') current.input += e.delta.partial_json;
      } else if (e.type === 'content_block_stop' && current) {
        if (current.type === 'tool_use') {
          try { current.input = JSON.parse(current.input); } catch { current.input = {}; }
        }
        content.push(current);
        current = null;
      } else if (e.type === 'message_delta') {
        stopReason = e.delta?.stop_reason || stopReason;
      }
    }
  }
  return { content, stop_reason: stopReason };
}

async function toolLoop(userText, system, tools) {
  const model = pickModel(userText);
  if (model !== MODEL_EXECUTOR) log(`⚡ Using smart model: ${model}`);
  const messages = [{ role: 'user', content: userText }];
  while (true) {
    let said = '';
    const { content, stop_reason } = await callAnthropicStream(messages, system, tools, model, {
      onText: (t) => { process.stdout.write(t); said += t; },
    });
    process.stdout.write('\n');
    messages.push({ role: 'assistant', content });

    if (stop_reason !== 'tool_use') { if (said.trim()) speak(said); return; }

    const toolResults = [];
    for (const block of content) {
      if (block.type !== 'tool_use') continue;
      log(`→ ${block.name}`);
      const result = await dispatchTool(block.name, block.input);
      const text = result.ok ? (result.stdout || 'ok') : `error: ${result.error || result.stderr || 'unknown'}`;
      toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: text.slice(0, 8000) });
    }
    messages.push({ role: 'user', content: toolResults });
  }
}

// ───────────── Haiku intent gate (studio mode) ─────────────

async function isDesignIntent(text) {
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL_GATE,
        max_tokens: 4,
        messages: [{
          role: 'user',
          content: `User said: "${text.replace(/"/g, '\\"')}". Is this a design/UI-building command for a tool that renders frames and components in Figma (verbs like create / add / make / build / change / delete / set applied to UI objects)? Reply with exactly "yes" or "no".`,
        }],
      }),
    });
    if (!res.ok) return false;
    const j = await res.json();
    const out = (j.content?.[0]?.text || '').toLowerCase().trim();
    return out.startsWith('y');
  } catch { return false; }
}

// ───────────── wake-phrase gate (call mode) ─────────────

let callWindowUntil = 0;
function wakeCheck(text) {
  const now = Date.now();
  const t = text.toLowerCase().trim();
  const wakeRe = new RegExp(`^(ok,?\\s+|okay,?\\s+)?${WAKE.replace(/\s+/g, '\\s+')}[,\\s]+(.+)`, 'i');
  const m = t.match(wakeRe);
  if (m) {
    callWindowUntil = now + CALL_WINDOW_MS;
    return m[2].trim(); // stripped command
  }
  if (now < callWindowUntil) {
    callWindowUntil = now + CALL_WINDOW_MS; // extend window on follow-up
    return t;
  }
  return null;
}

// ───────────── mic device picker ─────────────

async function listDshowDevices() {
  // ffmpeg writes device info to stderr. Combine both newer and older output formats:
  //   newer: [in#0 @ ...] "Device" (audio)
  //   older: [dshow @ ...] "Device" ...with a "DirectShow audio devices" section header above.
  const { stderr } = await sh('ffmpeg', ['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy']);
  const lines = stderr.split('\n');
  const audio = [];
  let inAudio = false;
  for (const line of lines) {
    if (line.includes('DirectShow audio devices')) { inAudio = true; continue; }
    if (line.includes('DirectShow video devices')) { inAudio = false; continue; }
    if (line.includes('Alternative name')) continue;
    const m = line.match(/"([^"]+)"/);
    if (!m) continue;
    if (line.includes('(audio)') || (inAudio && !line.includes('(video)'))) audio.push(m[1]);
  }
  return audio;
}

async function pickDevice() {
  if (MIC_DEVICE) return MIC_DEVICE;
  const devs = await listDshowDevices();
  if (!devs.length) die('No DirectShow audio devices found. Check mic permissions.');
  console.log('\nAudio input devices:');
  devs.forEach((d, i) => console.log(`  [${i}] ${d}`));
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise(res => rl.question('\nPick a device number (or press Enter for 0): ', res));
  rl.close();
  const idx = parseInt(answer, 10) || 0;
  const picked = devs[idx] || devs[0];
  log(`Using mic: ${picked}`);
  log(`Tip: add MIC_DEVICE="${picked}" to .env to skip the picker next time.`);
  return picked;
}

// ───────────── energy VAD + WAV writer ─────────────

function rms(int16) {
  let sum = 0;
  for (let i = 0; i < int16.length; i++) sum += int16[i] * int16[i];
  return Math.sqrt(sum / int16.length) / 32768;
}

function buildWavBuffer(int16) {
  const dataLen = int16.length * 2;
  const buf = Buffer.alloc(44 + dataLen);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataLen, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(SAMPLE_RATE, 24);
  buf.writeUInt32LE(SAMPLE_RATE * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataLen, 40);
  Buffer.from(int16.buffer, int16.byteOffset, dataLen).copy(buf, 44);
  return buf;
}

function writeWav(path, int16) {
  writeFileSync(path, buildWavBuffer(int16));
}

// Calibrate noise floor in first ~1 second, then use 3× as speech threshold.
function startRecorder(micDevice, onUtterance) {
  log(`Opening mic: ${micDevice}`);
  const ff = spawn('ffmpeg', [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'dshow',
    '-i', `audio=${micDevice}`,
    '-ac', '1',
    '-ar', String(SAMPLE_RATE),
    '-af', 'volume=20dB',
    '-f', 's16le',
    '-',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  ff.stderr.on('data', d => warn('ffmpeg:', d.toString().trim()));
  ff.on('close', code => {
    if (code !== 0) warn(`ffmpeg exited ${code}`);
    process.exit(code || 0);
  });

  const FRAME_SAMPLES = 480; // 30ms @ 16kHz
  const FRAME_BYTES = FRAME_SAMPLES * 2;
  const SILENCE_FRAMES = Math.ceil(VAD_SILENCE_MS / 30);
  let noiseFloor = 0.002;
  let noiseSamples = 0;
  let speaking = false;
  let silenceCount = 0;
  let speechBuf = [];
  let pre = [];
  const PRE_FRAMES = 10;
  let pending = Buffer.alloc(0);

  ff.stdout.on('data', chunk => {
    pending = Buffer.concat([pending, chunk]);
    while (pending.length >= FRAME_BYTES) {
      const frameBuf = pending.subarray(0, FRAME_BYTES);
      pending = pending.subarray(FRAME_BYTES);
      const int16 = new Int16Array(frameBuf.buffer, frameBuf.byteOffset, FRAME_SAMPLES);
      const level = rms(int16);

      if (noiseSamples < 67 && !speaking) {
        noiseFloor = (noiseFloor * noiseSamples + level) / (noiseSamples + 1);
        noiseSamples++;
        if (noiseSamples === 67) log(`Noise floor: ${noiseFloor.toFixed(4)} → threshold ${Math.max(noiseFloor * 8, 0.05).toFixed(4)}`);
      }

      const threshold = Math.max(noiseFloor * 8, 0.05);

      if (!speaking) {
        pre.push(new Int16Array(int16));
        if (pre.length > PRE_FRAMES) pre.shift();
        if (level > threshold) {
          speaking = true;
          speechBuf = pre.slice();
          pre = [];
          silenceCount = 0;
        }
      } else {
        speechBuf.push(new Int16Array(int16));
        if (level < threshold) {
          silenceCount++;
          if (silenceCount >= SILENCE_FRAMES) {
            const total = speechBuf.reduce((n, f) => n + f.length, 0);
            const merged = new Int16Array(total);
            let o = 0;
            for (const f of speechBuf) { merged.set(f, o); o += f.length; }
            speaking = false;
            speechBuf = [];
            silenceCount = 0;
            if (total < SAMPLE_RATE * 0.8) continue;
            onUtterance(merged);
          }
        } else {
          silenceCount = 0;
        }
      }
    }
  });

  return () => { ff.kill('SIGINT'); };
}

const GROQ_API_KEY = process.env.GROQ_API_KEY;

async function transcribeGroq(int16) {
  const wav = buildWavBuffer(int16);
  const form = new FormData();
  form.append('file', new Blob([wav], { type: 'audio/wav' }), 'audio.wav');
  form.append('model', 'whisper-large-v3');
  form.append('language', 'en');
  form.append('response_format', 'text');
  form.append('temperature', '0');
  form.append('prompt', 'Hey Figma. Make, create, add, delete, rename, resize, move, change. Rectangle, circle, ellipse, frame, group, component, variant, button, card, input, text, icon, logo. Shadcn, Linear, Tailwind, Material, design system, design tokens, variables, collection. Primary, secondary, surface, canvas, ink, hairline, muted, subtle, success, destructive. Auto layout, padding, spacing, gap, border radius, stroke, fill, opacity, shadow. Rounded, pill, outlined, filled, ghost, hover. Pricing card, hero, navbar, sidebar, modal, dropdown, tooltip.');
  const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${GROQ_API_KEY}` },
    body: form,
  });
  if (!res.ok) { warn('groq:', res.status, await res.text().catch(() => '')); return ''; }
  return (await res.text()).trim();
}

async function transcribeLocal(int16) {
  const tmp = join(tmpdir(), `vtf-${Date.now()}.wav`);
  writeWav(tmp, int16);
  const { code, stdout, stderr } = await sh(WHISPER_BIN, [
    '-m', WHISPER_MODEL,
    '-f', tmp,
    '-nt', '-np',
    '-l', 'en',
    '-t', '8',
    '--initial-prompt', 'Hey Figma. Create rectangle circle frame component button text. Shadcn design system tokens auto layout variant fill stroke opacity padding spacing border radius font color shadow background primary secondary. Delete rename resize move.',
    '--output-txt',
    '-of', tmp.replace(/\.wav$/, ''),
  ]);
  try { unlinkSync(tmp); } catch {}
  const txtPath = tmp.replace(/\.wav$/, '.txt');
  let text = '';
  try { text = readFileSync(txtPath, 'utf-8').trim(); unlinkSync(txtPath); } catch {}
  if (!text) text = (stdout || '').trim();
  if (!text && code !== 0) warn('whisper stderr:', stderr.trim().split('\n').pop());
  return text;
}

async function transcribe(int16) {
  return GROQ_API_KEY ? transcribeGroq(int16) : transcribeLocal(int16);
}

// ───────────── main loop ─────────────

async function main() {
  if (LIST_DEVICES) {
    const devs = await listDshowDevices();
    devs.forEach((d, i) => console.log(`[${i}] ${d}`));
    return;
  }

  const ok = await preflight();
  if (!ok) process.exit(1);
  if (PREFLIGHT_ONLY) return;

  log(`Mode: ${MODE}  |  Wake: "${WAKE}"  |  cwd: ${process.cwd()}`);
  const [system, tools, micDevice] = await Promise.all([
    buildSystemPrompt(),
    Promise.resolve(loadTools()),
    pickDevice(),
  ]);
  log(`System prompt: ${system.length} blocks  |  Tools: ${tools.length}`);

  let busy = false;
  const stop = startRecorder(micDevice, async (int16) => {
    if (busy) { log('(busy — dropping utterance)'); return; }
    busy = true;
    try {
      const t0 = Date.now();
      const text = await transcribe(int16);
      if (!text) { busy = false; return; }
      log(`heard (${Date.now()-t0}ms): "${text}"`);

      const stopRe = /\b(thank you|thanks|goodbye|bye|stop|quit|exit|that's it|that is it)\s*,?\s*figma\b/i;
      if (stopRe.test(text)) {
        log('👋 Stop phrase detected. Goodbye.');
        speak("Goodbye");
        setTimeout(() => process.exit(0), 1200);
        return;
      }

      let command = null;
      if (MODE === 'call') {
        command = wakeCheck(text);
        if (!command) { busy = false; return; }
        speak("okay"); // instant audio ack so user knows it heard them
      } else {
        const yes = await isDesignIntent(text);
        if (!yes) { log('(not a design command)'); busy = false; return; }
        command = text;
      }
      log(`→ ${command}`);
      await toolLoop(command, system, tools);
    } catch (err) {
      warn('loop error:', err.message);
    } finally {
      busy = false;
    }
  });

  console.log('\n🎙  Listening. Say "' + WAKE + ', <command>". Ctrl-C to quit.\n');
  process.on('SIGINT', () => { stop?.(); process.exit(0); });
}

main().catch(err => { console.error(err); process.exit(1); });
