/**
 * view-image.test.mjs — the view_image tool.
 *
 * Covers the positive image path (content block + structured metadata),
 * resizing rules (2000px / 512px for detail=low), the animated marker and the
 * image error codes (E_NOT_IMAGE, E_NOT_FOUND, E_UNSUPPORTED_FORMAT).
 *
 * Contract: README.md ("view_image"), enforced by tests/tool-contract.test.mjs.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { rpc, rpcRaw, makePng } from './helpers.mjs';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => path.join(__dir, 'fixture', name);

/** Inline limit from src/image_resize.h (4.5 MB of base64). */
const MAX_IMAGE_BASE64_BYTES = 4718592;

function tmpFile(buf, ext) {
  const p = path.join(os.tmpdir(),
    `boxsh-img-${process.pid}-${Math.random().toString(36).slice(2)}${ext}`);
  fs.writeFileSync(p, buf);
  return p;
}

const tmpPng = (buf) => tmpFile(buf, '.png');

/**
 * Minimal 8-bit PNG reader (all five scanline filters), used to check which
 * frame of an animated source actually reached the client.
 * @param {Buffer} buf
 * @returns {{ width: number, height: number, channels: number, pixels: Buffer }}
 */
function readPng(buf) {
  assert.equal(buf.readUInt32BE(0), 0x89504e47, 'not a PNG');
  let off = 8, width = 0, height = 0, bitDepth = 0, colorType = 0;
  const idat = [];
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(data));
    } else if (type === 'IEND') {
      break;
    }
    off += 12 + len;
  }
  assert.equal(bitDepth, 8, 'test reader only handles 8-bit PNGs');
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  assert.ok(channels, `test reader does not handle PNG colour type ${colorType}`);

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const pixels = Buffer.alloc(stride * height);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const cur = Buffer.from(raw.subarray(y * (stride + 1) + 1,
                                          y * (stride + 1) + 1 + stride));
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? cur[i - channels] : 0;
      const b = prev[i];
      const c = i >= channels ? prev[i - channels] : 0;
      if (filter === 1) cur[i] = (cur[i] + a) & 0xff;
      else if (filter === 2) cur[i] = (cur[i] + b) & 0xff;
      else if (filter === 3) cur[i] = (cur[i] + ((a + b) >> 1)) & 0xff;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        const pr = (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
        cur[i] = (cur[i] + pr) & 0xff;
      }
    }
    cur.copy(pixels, y * stride);
    prev = cur;
  }
  return { width, height, channels, pixels };
}

/** view_image call returning the raw JSON-RPC response. */
function viewImage(args, opts) {
  return rpcRaw({ id: '1', tool: 'view_image', ...args }, opts);
}

/** result.structuredContent of a raw response. */
const scOf = (resp) => resp.result.structuredContent ?? {};

/** Text block of a result, for old-client readability checks. */
const textOf = (resp) => resp.result.content?.[0]?.text ?? '';

const isError = (resp) => resp.result.isError === true;

function imageOf(resp) {
  const content = resp.result.content;
  assert.ok(Array.isArray(content), 'content must be an array');
  const block = content.find(c => c.type === 'image');
  assert.ok(block, `no image block in ${JSON.stringify(content).slice(0, 200)}`);
  return block;
}

// ---------------------------------------------------------------------------
// Positive path
// ---------------------------------------------------------------------------

describe('view_image — positive', () => {
  test('returns an image block plus metadata for a small PNG', () => {
    const p = fixture('fixture.png');
    const resp = viewImage({ path: p });
    assert.ok(!isError(resp), `unexpected error: ${textOf(resp)}`);

    const img = imageOf(resp);
    assert.equal(img.mimeType, 'image/png');
    assert.ok(img.data.length > 0, 'image data must not be empty');
    assert.ok(Buffer.from(img.data, 'base64').length > 0, 'data must be valid base64');

    const sc = scOf(resp);
    assert.equal(sc.encoding, 'image');
    assert.equal(sc.mime_type, 'image/png');
    assert.equal(sc.width, 200);
    assert.equal(sc.height, 133);
    assert.equal(sc.original_width, 200);
    assert.equal(sc.original_height, 133);
    assert.equal(sc.was_resized, false);
    assert.equal(sc.animated, false);
    assert.equal(sc.size, fs.statSync(p).size);

    // Model-readable text, no JSON dump.
    assert.match(textOf(resp), /^\[Image: image\/png, 200x133\]$/);
  });

  test('downscales images larger than 2000px and reports the resize', () => {
    const p = tmpPng(makePng(2200, 1400, { solid: true }));
    try {
      const resp = viewImage({ path: p });
      assert.ok(!isError(resp), `unexpected error: ${textOf(resp)}`);

      const sc = scOf(resp);
      assert.equal(sc.was_resized, true);
      assert.equal(sc.original_width, 2200);
      assert.equal(sc.original_height, 1400);
      assert.ok(sc.width <= 2000 && sc.height <= 2000,
        `expected <= 2000px, got ${sc.width}x${sc.height}`);
      assert.ok(imageOf(resp).data.length <= MAX_IMAGE_BASE64_BYTES,
        'base64 payload must stay within the inline budget');
      assert.match(textOf(resp), /resized from 2200x1400/);
    } finally { fs.rmSync(p, { force: true }); }
  });

  test("detail='low' caps the longest edge at 512px", () => {
    const p = tmpPng(makePng(2200, 1400, { solid: true }));
    try {
      const resp = viewImage({ path: p, detail: 'low' });
      assert.ok(!isError(resp), `unexpected error: ${textOf(resp)}`);

      const sc = scOf(resp);
      assert.ok(sc.width <= 512 && sc.height <= 512,
        `expected <= 512px, got ${sc.width}x${sc.height}`);
      assert.match(textOf(resp), /low detail/);
    } finally { fs.rmSync(p, { force: true }); }
  });

  test('marks a static image as animated=false', () => {
    const resp = viewImage({ path: fixture('fixture.png') });
    assert.equal(scOf(resp).animated, false);
    assert.ok(!/animated/.test(textOf(resp)), 'text should not claim animation');
  });

  test('marks an animated source and returns its first frame', () => {
    const resp = viewImage({ path: fixture('fixture.apng') });
    assert.ok(!isError(resp), `unexpected error: ${textOf(resp)}`);
    assert.equal(scOf(resp).animated, true);
    assert.match(textOf(resp), /animated, first frame/);

    // "first frame only" must be enforced: the animated source is re-encoded
    // and the returned payload no longer carries the animation chunks.
    const data = Buffer.from(imageOf(resp).data, 'base64');
    assert.ok(!data.includes('acTL'),
      'returned payload must not contain the APNG animation control chunk');
    const original = fs.readFileSync(fixture('fixture.apng'));
    assert.ok(!data.equals(original), 'animated sources must be re-encoded');
    assert.equal(scOf(resp).was_resized, false, 'dimensions were not changed');
  });

  test('jpeg and gif pass through in their native format', () => {
    for (const [name, expectedMime] of [['fixture.gif', 'image/gif'],
                                       ['fixture.jpg', 'image/jpeg']]) {
      const resp = viewImage({ path: fixture(name) });
      assert.ok(!isError(resp), `${name}: unexpected error: ${textOf(resp)}`);
      assert.equal(scOf(resp).mime_type, expectedMime);
      assert.equal(scOf(resp).converted, false,
        `${name}: model-native format must not be re-encoded`);
      assert.ok(imageOf(resp).data.length > 0, `${name}: image data missing`);
    }
  });

  test('bmp is converted to a model-native format (png/jpeg)', () => {
    // Multimodal models ingest jpeg/png/gif/webp natively; everything else
    // (bmp, tiff, …) must be re-encoded so the client model can see it.
    const resp = viewImage({ path: fixture('fixture.bmp') });
    assert.ok(!isError(resp), `unexpected error: ${textOf(resp)}`);

    const sc = scOf(resp);
    assert.equal(sc.converted, true);
    assert.ok(['image/png', 'image/jpeg'].includes(sc.mime_type),
      `expected a converted still, got ${sc.mime_type}`);
    assert.equal(sc.width, 200, 'dimensions must be preserved');
    assert.equal(sc.height, 133);
    assert.equal(sc.was_resized, false, 'conversion is not a resize');
    assert.match(textOf(resp), /converted from image\/bmp/);
    assert.match(textOf(resp), /^\[Image: (image\/png|image\/jpeg), 200x133, converted from image\/bmp\]$/);

    // The payload must differ from the original BMP bytes (it is re-encoded).
    assert.ok(!Buffer.from(imageOf(resp).data, 'base64')
                 .equals(fs.readFileSync(fixture('fixture.bmp'))),
      'converted output must not be the original BMP bytes');
  });

  test('webp is decoded (vendored libwebp decoder)', () => {
    const resp = viewImage({ path: fixture('fixture.webp') });
    assert.ok(!isError(resp), `unexpected error: ${textOf(resp)}`);

    const sc = scOf(resp);
    assert.equal(sc.mime_type, 'image/webp');
    assert.equal(sc.width, 200);
    assert.equal(sc.height, 133);
    assert.equal(sc.animated, false);
    assert.match(textOf(resp), /^\[Image: image\/webp, 200x133\]$/);
    assert.ok(imageOf(resp).data.length > 0);
  });

  test('large webp goes through the resize/re-encode path', () => {
    // tests/fixture/boxsh-large.webp is a generated 2400x1600 gradient.
    const resp = viewImage({ path: fixture('boxsh-large.webp') });
    assert.ok(!isError(resp), `unexpected error: ${textOf(resp)}`);

    const sc = scOf(resp);
    assert.equal(sc.original_width, 2400);
    assert.equal(sc.original_height, 1600);
    assert.equal(sc.was_resized, true);
    assert.ok(sc.width <= 2000 && sc.height <= 2000,
      `expected <= 2000px, got ${sc.width}x${sc.height}`);
    assert.ok(['image/png', 'image/jpeg'].includes(sc.mime_type),
      `expected a re-encoded still, got ${sc.mime_type}`);
    assert.match(textOf(resp), /resized from 2400x1600/);
  });

  test('animated webp returns its first frame only', () => {
    // tests/fixture/boxsh-animated.webp holds two frames: a solid red one
    // (220,40,40) followed by a solid blue one (40,60,220).
    const p = fixture('boxsh-animated.webp');
    const resp = viewImage({ path: p });
    assert.ok(!isError(resp), `unexpected error: ${textOf(resp)}`);

    const sc = scOf(resp);
    assert.equal(sc.animated, true);
    assert.equal(sc.width, 64);
    assert.equal(sc.height, 48);
    assert.equal(sc.was_resized, false);
    assert.match(textOf(resp), /animated, first frame/);

    // The animation container must not reach the client: the payload is a
    // re-encoded still, not the original file.
    const data = Buffer.from(imageOf(resp).data, 'base64');
    assert.ok(!data.equals(fs.readFileSync(p)), 'animated webp must be re-encoded');
    assert.ok(!data.includes('ANIM'), 'no ANIM chunk in the returned payload');

    // …and that still is the FIRST frame, not the last one.  (The encoder
    // picks PNG for this two-colour image; skip the pixel check otherwise.)
    if (sc.mime_type === 'image/png') {
      const png = readPng(data);
      const [r0, g0, b0] = [png.pixels[0], png.pixels[1], png.pixels[2]];
      assert.ok(r0 > 180 && g0 < 90 && b0 < 90,
        `expected the red first frame, got rgb(${r0},${g0},${b0})`);
      const last = (png.height - 1) * png.width * png.channels;
      const [r1, g1, b1] = [png.pixels[last], png.pixels[last + 1], png.pixels[last + 2]];
      assert.ok(r1 > 180 && g1 < 90 && b1 < 90,
        `expected the whole canvas to be the first frame, bottom-right is rgb(${r1},${g1},${b1})`);
    }
  });

  test('crafted chunk length in a webp cannot hang the animation scan', () => {
    // RIFF/WEBP + a chunk whose 32-bit length would wrap the scan offset.
    const p = tmpFile(Buffer.concat([
      Buffer.from('RIFF'), Buffer.from([0x10, 0, 0, 0]), Buffer.from('WEBP'),
      Buffer.from('XXXX'), Buffer.from([0xf8, 0xff, 0xff, 0xff]),
    ]), '.webp');
    try {
      const resp = viewImage({ path: p }, { timeout_ms: 8000 });
      assert.ok(isError(resp), 'a malformed webp must not be decoded');
      assert.equal(scOf(resp).code, 'E_UNSUPPORTED_FORMAT');
    } finally { fs.rmSync(p, { force: true }); }
  });

  test('crafted chunk length in a png cannot hang the animation scan', () => {
    const p = tmpPng(Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from([0xf4, 0xff, 0xff, 0xff]), Buffer.from('XXXX'),
      Buffer.from([0, 0, 0, 0]),
    ]));
    try {
      const resp = viewImage({ path: p }, { timeout_ms: 8000 });
      assert.ok(isError(resp), 'a malformed png must not be decoded');
      assert.equal(scOf(resp).code, 'E_UNSUPPORTED_FORMAT');
    } finally { fs.rmSync(p, { force: true }); }
  });
});

// ---------------------------------------------------------------------------
// Error codes
// ---------------------------------------------------------------------------

describe('view_image — errors', () => {
  test('non-image file returns E_NOT_IMAGE', () => {
    const p = path.join(os.tmpdir(), `boxsh-img-txt-${process.pid}.txt`);
    fs.writeFileSync(p, 'hello\n');
    try {
      const resp = viewImage({ path: p });
      const sc = scOf(resp);
      assert.equal(sc.code, 'E_NOT_IMAGE');
      assert.ok(isError(resp), 'must be flagged as an error');
      assert.match(sc.message, /view_image:/);
      assert.ok(textOf(resp).startsWith('E_NOT_IMAGE: '),
        'text must lead with the stable code');
    } finally { fs.rmSync(p, { force: true }); }
  });

  test('missing file returns E_NOT_FOUND', () => {
    const resp = viewImage({ path: '/nonexistent/boxsh-test-image.png' });
    assert.equal(scOf(resp).code, 'E_NOT_FOUND');
    assert.ok(isError(resp));
  });

  test('webp metadata-only edge case: a JSON file named .webp is not an image', () => {
    // tests/fixture/fixture-json.webp is 19 bytes of JSON, not an image.
    const resp = viewImage({ path: fixture('fixture-json.webp') });
    assert.equal(scOf(resp).code, 'E_NOT_IMAGE');
  });

  test('undecodable image format returns E_UNSUPPORTED_FORMAT', () => {
    const resp = viewImage({ path: fixture('fixture.jxl') });
    const sc = scOf(resp);
    assert.equal(sc.code, 'E_UNSUPPORTED_FORMAT');
    assert.ok(sc.detail?.supported.includes('image/png'));
    assert.ok(sc.detail?.supported.includes('image/webp'),
      'webp is decodable in this build, so it must be advertised');
  });

  test('invalid detail value is rejected as a protocol error', () => {
    const resp = rpc({ id: '1', tool: 'view_image',
                       path: fixture('fixture.png'), detail: 'huge' });
    assert.ok(resp.error, 'expected an error for an invalid detail value');
    assert.match(resp.error, /detail/);
  });

  test('missing path argument is rejected as a protocol error', () => {
    const resp = rpc({ id: '1', tool: 'view_image' });
    assert.ok(resp.error, 'expected an error for a missing path');
    assert.match(resp.error, /path/);
  });
});
