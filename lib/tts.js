// edge-tts 协议客户端：通过微软 Edge 朗读接口用 WebSocket 合成 MP3。
// 协议对齐 Python edge-tts 库（Sec-MS-GEC DRM 令牌 + MUID Cookie + 时钟偏移校正）。
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const CHROMIUM_FULL_VERSION = '143.0.3650.75';
const CHROMIUM_MAJOR_VERSION = CHROMIUM_FULL_VERSION.split('.')[0];
const SEC_MS_GEC_VERSION = `1-${CHROMIUM_FULL_VERSION}`;
const BASE_URL = 'speech.platform.bing.com/consumer/speech/synthesize/readaloud';
const WSS_URL = `wss://${BASE_URL}/edge/v1?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}`;
const VOICES_URL = `https://${BASE_URL}/voices/list?trustedclienttoken=${TRUSTED_CLIENT_TOKEN}`;
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  `(KHTML, like Gecko) Chrome/${CHROMIUM_MAJOR_VERSION}.0.0.0 Safari/537.36` +
  ` Edg/${CHROMIUM_MAJOR_VERSION}.0.0.0`;

const WIN_EPOCH = 11644473600;
const MAX_TEXT_BYTES = 4096;

// 服务端与本机时钟的偏差（秒），403 时根据响应 Date 头校正
let clockSkewSeconds = 0;

function secMsGec() {
  let ticks = Math.floor(Date.now() / 1000 + clockSkewSeconds) + WIN_EPOCH;
  ticks -= ticks % 300;                       // 向下取整到 5 分钟
  const str = String(BigInt(ticks) * 10000000n) + TRUSTED_CLIENT_TOKEN;
  return crypto.createHash('sha256').update(str, 'ascii').digest('hex').toUpperCase();
}

function adjustClockSkew(serverDate) {
  const t = Date.parse(serverDate);
  if (!Number.isNaN(t)) clockSkewSeconds += t / 1000 - Date.now() / 1000;
}

const muid = () => crypto.randomBytes(16).toString('hex').toUpperCase();
const connectId = () => crypto.randomUUID().replace(/-/g, '');

function dateToString() {
  return new Date().toUTCString().replace('GMT', 'GMT+0000 (Coordinated Universal Time)');
}

const escapeSsml = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
           .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

// 服务端不支持部分控制字符（0-8/11-12/14-31），替换为空格
function removeIncompatibleCharacters(s) {
  let out = '';
  for (const ch of String(s)) {
    const c = ch.codePointAt(0);
    out += (c <= 8 || (c >= 11 && c <= 12) || (c >= 14 && c <= 31)) ? ' ' : ch;
  }
  return out;
}

// 按 4096 字节分块，优先在换行/空格处断开，保证不切断多字节字符与 XML 实体
function splitTextByByteLength(text, byteLength) {
  const chunks = [];
  let buf = Buffer.from(text, 'utf8');
  while (buf.length > byteLength) {
    let splitAt = buf.lastIndexOf(0x0a, byteLength);
    if (splitAt < 0) splitAt = buf.lastIndexOf(0x20, byteLength);
    if (splitAt < 0) {                      // 无空白可用，回退到 UTF-8 安全边界
      splitAt = byteLength;
      while (splitAt > 0 && (buf[splitAt] & 0xc0) === 0x80) splitAt--;
    }
    while (splitAt > 0) {                    // 不要切在 &amp; 这类实体中间
      const amp = buf.lastIndexOf(0x26, splitAt - 1);
      if (amp < 0) break;
      if (buf.indexOf(0x3b, amp, splitAt) !== -1) break;
      splitAt = amp;
    }
    if (splitAt <= 0) throw new Error('文本无法安全分块');
    const chunk = buf.slice(0, splitAt).toString('utf8').trim();
    if (chunk) chunks.push(chunk);
    buf = buf.slice(splitAt);
  }
  const rest = buf.toString('utf8').trim();
  if (rest) chunks.push(rest);
  return chunks;
}

function parseMessageHeaders(data, headerLength) {
  const headers = {};
  for (const line of data.slice(0, headerLength).toString('latin1').split('\r\n')) {
    const idx = line.indexOf(':');
    if (idx > 0) headers[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return headers;
}

/** 单块文本 → 一个 WebSocket 连接的音频。403 时自动校正时钟并重试一次。 */
function synthChunk(chunk, voice, rate, volume, pitch) {
  const attempt = () => new Promise((resolve, reject) => {
    const url = `${WSS_URL}&ConnectionId=${connectId()}` +
                `&Sec-MS-GEC=${secMsGec()}&Sec-MS-GEC-Version=${SEC_MS_GEC_VERSION}`;
    const ws = new WebSocket(url, {
      headers: {
        'Pragma': 'no-cache',
        'Cache-Control': 'no-cache',
        'Origin': 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
        'User-Agent': USER_AGENT,
        'Cookie': `muid=${muid()};`,
      },
    });
    const chunks = [];
    let settled = false;
    let timer = null;
    const done = (err, buf) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch (_) {}
      err ? reject(err) : resolve(buf);
    };
    const armTimeout = () => {
      clearTimeout(timer);
      timer = setTimeout(() => done(new Error('TTS 合成超时(60s)')), 60000);
    };

    ws.on('unexpected-response', (_req, res) => {
      if (res.statusCode === 403) {
        adjustClockSkew(res.headers.date);
        done({ retry403: true });
      } else {
        done(new Error(`服务端拒绝: HTTP ${res.statusCode}`));
      }
    });
    ws.on('error', (err) => done(settled ? null : err));

    ws.on('open', () => {
      armTimeout();
      ws.send(
        `X-Timestamp:${dateToString()}\r\n` +
        `Content-Type:application/json; charset=utf-8\r\n` +
        `Path:speech.config\r\n\r\n` +
        `{"context":{"synthesis":{"audio":{"metadataoptions":` +
        `{"sentenceBoundaryEnabled":"true","wordBoundaryEnabled":"false"},` +
        `"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}\r\n`
      );
      const ssml =
        `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>` +
        `<voice name='${escapeSsml(voice)}'>` +
        `<prosody pitch='${pitch >= 0 ? '+' : ''}${pitch}Hz' ` +
        `rate='${rate >= 0 ? '+' : ''}${rate}%' volume='${volume >= 0 ? '+' : ''}${volume}%'>` +
        `${escapeSsml(chunk)}</prosody></voice></speak>`;
      ws.send(
        `X-RequestId:${connectId()}\r\n` +
        `Content-Type:application/ssml+xml\r\n` +
        `X-Timestamp:${dateToString()}Z\r\n` +   // 末尾 Z 是微软服务的约定
        `Path:ssml\r\n\r\n${ssml}`
      );
    });

    ws.on('message', (data, isBinary) => {
      armTimeout();
      if (isBinary) {
        if (data.length < 2) return;
        const headLen = data.readUInt16BE(0);
        if (headLen > data.length) return;
        const headers = parseMessageHeaders(data, headLen);
        if (headers['Path'] !== 'audio') return;
        chunks.push(data.slice(headLen + 2));
      } else {
        const msg = data.toString('utf8');
        if (msg.includes('Path:turn.end')) {
          const out = Buffer.concat(chunks);
          out.length ? done(null, out) : done(new Error('TTS 未返回音频'));
        }
      }
    });

    ws.on('close', () => {
      if (!settled && chunks.length) done(null, Buffer.concat(chunks));
      else if (!settled) done(new Error('连接在合成完成前被关闭'));
    });
  });

  return attempt().catch((err) =>
    err && err.retry403 ? attempt() : Promise.reject(err));
}

/** 合成语音，返回完整 MP3 Buffer（长文本自动分块串联合成）。 */
async function synthBuffer(text, voice, rate = 0, volume = 0, pitch = 0) {
  const escaped = escapeSsml(removeIncompatibleCharacters(text));
  const chunks = splitTextByByteLength(escaped, MAX_TEXT_BYTES);
  const parts = [];
  for (const chunk of chunks) {
    parts.push(await synthChunk(chunk, voice, rate, volume, pitch));
  }
  return Buffer.concat(parts);
}

/** 拉取音色列表（全量，调用方自行过滤中文）。 */
async function listVoices() {
  const doFetch = () => fetch(
    `${VOICES_URL}&Sec-MS-GEC=${secMsGec()}&Sec-MS-GEC-Version=${SEC_MS_GEC_VERSION}`, {
    headers: {
      'User-Agent': USER_AGENT,
      'Accept': '*/*',
      'Sec-CH-UA': `" Not;A Brand";v="99", "Microsoft Edge";v="${CHROMIUM_MAJOR_VERSION}",` +
                   ` "Chromium";v="${CHROMIUM_MAJOR_VERSION}"`,
      'Sec-CH-UA-Mobile': '?0',
      'Sec-Fetch-Site': 'none',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Dest': 'empty',
      'Cookie': `muid=${muid()};`,
    },
  });
  let res = await doFetch();
  if (res.status === 403) {                  // 时钟偏差：按服务端时间校正后重试一次
    adjustClockSkew(res.headers.get('date'));
    res = await doFetch();
  }
  if (!res.ok) throw new Error(`获取音色列表失败: HTTP ${res.status}`);
  return res.json();
}

/** 带磁盘缓存的合成：返回 mp3 文件路径。缓存键 = 文本|音色|语速|音量（sha1 命名，跨进程稳定）。 */
async function synth(cacheDir, text, voice, rate = 0, volume = 0) {
  await fs.promises.mkdir(cacheDir, { recursive: true });
  const key = `${text}|${voice}|${rate}|${volume}`;
  const file = path.join(cacheDir, crypto.createHash('sha1').update(key).digest('hex') + '.mp3');
  try { await fs.promises.access(file); return file; } catch (_) {}
  const buf = await synthBuffer(text, voice, rate, volume);
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.promises.writeFile(tmp, buf);
  await fs.promises.rename(tmp, file);
  return file;
}

module.exports = { synth, synthBuffer, listVoices };
