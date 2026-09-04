"use strict";
/**
 * Dependency-free captcha image generator.
 * Renders a 4-digit code into a real, human-readable PNG (no native modules,
 * works on Railway's runtime). Returns base64 PNG data.
 */
const zlib = require("zlib");
const crypto = require("crypto");

// 5x7 bitmap font for digits 0-9
const FONT = {
  "0": ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
  "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
  "2": ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
  "3": ["11110", "00001", "00001", "01110", "00001", "00001", "11110"],
  "4": ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
  "5": ["11111", "10000", "11110", "00001", "00001", "10001", "01110"],
  "6": ["00110", "01000", "10000", "11110", "10001", "10001", "01110"],
  "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
  "8": ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
  "9": ["01110", "10001", "10001", "01111", "00001", "00010", "01100"],
};

function crc32(buf) {
  let c;
  const table = crc32.table || (crc32.table = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })());
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(width, height, rgb) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  let o = 0;
  for (let y = 0; y < height; y++) {
    raw[o++] = 0; // filter: none
    rgb.copy(raw, o, y * width * 3, (y + 1) * width * 3);
    o += width * 3;
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolor
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function randInt(n) {
  return crypto.randomInt(n);
}

/**
 * @param {string} code 4 digits
 * @returns {{ code: string, imageB64: string }}
 */
function renderCaptcha(code) {
  const W = 160;
  const H = 56;
  const px = Buffer.alloc(W * H * 3, 0xf2);

  const set = (x, y, r, g, b) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const i = (y * W + x) * 3;
    px[i] = r; px[i + 1] = g; px[i + 2] = b;
  };

  // background speckle noise
  for (let i = 0; i < 900; i++) {
    const v = 190 + randInt(50);
    set(randInt(W), randInt(H), v, v, v);
  }

  // digits
  const scale = 5;
  const glyphW = 5 * scale;
  const gap = 8;
  const totalW = code.length * glyphW + (code.length - 1) * gap;
  let x0 = Math.floor((W - totalW) / 2);
  for (const ch of code) {
    const rows = FONT[ch] || FONT["0"];
    const yOff = Math.floor((H - 7 * scale) / 2) + randInt(7) - 3;
    const skew = randInt(3) - 1;
    const col = [20 + randInt(50), 20 + randInt(50), 60 + randInt(70)];
    for (let ry = 0; ry < 7; ry++) {
      for (let rx = 0; rx < 5; rx++) {
        if (rows[ry][rx] !== "1") continue;
        for (let sy = 0; sy < scale; sy++) {
          for (let sx = 0; sx < scale; sx++) {
            const y = yOff + ry * scale + sy;
            const x = x0 + rx * scale + sx + Math.round((skew * (7 * scale - (ry * scale + sy))) / 8);
            set(x, y, col[0], col[1], col[2]);
          }
        }
      }
    }
    x0 += glyphW + gap;
  }

  // interference lines
  for (let l = 0; l < 3; l++) {
    const y1 = randInt(H);
    const y2 = randInt(H);
    const c = [90 + randInt(90), 90 + randInt(90), 90 + randInt(90)];
    for (let x = 0; x < W; x++) {
      const y = Math.round(y1 + ((y2 - y1) * x) / W);
      set(x, y, c[0], c[1], c[2]);
      set(x, y + 1, c[0], c[1], c[2]);
    }
  }

  return { code, imageB64: encodePng(W, H, px).toString("base64") };
}

function newCaptcha() {
  let code = "";
  for (let i = 0; i < 4; i++) code += String(randInt(10));
  return renderCaptcha(code);
}

module.exports = { newCaptcha, renderCaptcha };
