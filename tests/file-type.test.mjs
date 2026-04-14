/**
 * file-type.test.mjs — MIME detection accuracy tests.
 *
 * Reads fixture files via boxsh `read` tool and asserts the returned
 * `mime_type` matches expected values.  Fixture files come from the
 * npm `file-type` project and live in ./fixture/.
 *
 * Only formats that file_type.cpp actually detects are tested here.
 * Unsupported formats are expected to return "application/octet-stream".
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rpc } from './helpers.mjs';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(__dir, 'fixture');

// -----------------------------------------------------------------------
// Mapping: fixture file → expected MIME type
//
// Follows the same structure as file-type's test.js:
//   - `names` defines fixtures with non-default names
//   - `types` maps extension → expected MIME from our file_type.cpp
// -----------------------------------------------------------------------

// Extension → expected MIME (only formats file_type.cpp supports)
const types = {
  // --- Images ---
  jpg:   'image/jpeg',
  png:   'image/png',
  gif:   'image/gif',
  webp:  'image/webp',
  bmp:   'image/bmp',
  ico:   'image/x-icon',
  cur:   'image/x-icon',
  tif:   'image/tiff',
  jxl:   'image/jxl',
  jp2:   'image/jp2',
  jxr:   'image/vnd.ms-photo',
  psd:   'image/vnd.adobe.photoshop',
  avif:  'image/avif',
  heic:  'image/heic',
  raf:   'image/x-fujifilm-raf',

  // --- Audio ---
  mp3:   'audio/mpeg',
  mp2:   'audio/mpeg',
  mp1:   'audio/mpeg',
  ogg:   'audio/ogg',
  flac:  'audio/flac',
  mid:   'audio/midi',
  wav:   'audio/wav',
  aif:   'audio/aiff',
  aac:   'audio/aac',
  amr:   'audio/amr',
  ac3:   'audio/vnd.dolby.dd-raw',
  voc:   'audio/x-voc',
  mpc:   'audio/x-musepack',
  wv:    'audio/wavpack',

  // --- Video ---
  mp4:   'video/mp4',
  mov:   'video/quicktime',
  mkv:   'video/x-matroska',
  webm:  'video/x-matroska',
  flv:   'video/x-flv',
  avi:   'video/x-msvideo',
  mpg:   'video/mpeg',
  asf:   'video/x-ms-asf',
  mts:   'video/mp2t',

  // --- Archives / Compressed ---
  zip:   'application/zip',
  gz:    'application/gzip',
  bz2:   'application/x-bzip2',
  xz:    'application/x-xz',
  zst:   'application/zstd',
  '7z':  'application/x-7z-compressed',
  rar:   'application/x-rar-compressed',
  lz4:   'application/x-lz4',
  lz:    'application/x-lzip',
  Z:     'application/x-compress',
  tar:   'application/x-tar',
  rpm:   'application/x-rpm',
  deb:   'application/x-deb',
  ar:    'application/x-archive',
  cpio:  'application/x-cpio',

  // --- Documents ---
  pdf:   'application/pdf',
  cfb:   'application/x-cfb',
  ps:    'application/postscript',
  arrow: 'application/x-arrow',
  parquet: 'application/x-parquet',
  sqlite: 'application/x-sqlite3',

  // --- Executables ---
  elf:   'application/x-executable',
  macho: 'application/x-mach-binary',
  exe:   'application/x-dosexec',
  class: 'application/java-vm',

  // --- Fonts ---
  ttf:   'font/ttf',
  otf:   'font/otf',
  woff:  'font/woff',
  woff2: 'font/woff2',

  // --- Other ---
  wasm:  'application/wasm',
  glb:   'model/gltf-binary',
  swf:   'application/x-shockwave-flash',
  nes:   'application/x-nes-rom',
  pcap:  'application/vnd.tcpdump.pcap',
};

// Fixtures with non-default names (mirrors file-type's `names` map,
// filtered to formats we support).
const names = {
  aac: [
    'fixture-adts-mpeg2',
    'fixture-adts-mpeg4',
    'fixture-adts-mpeg4-2',
    'fixture-id3v2',  // ID3v2 header → detected as audio/mpeg, not aac
  ],
  mp3: [
    'fixture',
    'fixture-mp2l3',
    'fixture-ffe3',
  ],
  mp2: [
    'fixture',
    'fixture-mpa',
  ],
  mp4: [
    'fixture-imovie',
    'fixture-isom',
    'fixture-isomv2',
    'fixture-mp4v2',
    'fixture-dash',
  ],
  mov: [
    'fixture',
    'fixture-mjpeg',
    'fixture-moov',
  ],
  mkv: [
    'fixture',
    'fixture2',
  ],
  mpg: [
    'fixture',
    'fixture2',
    'fixture.ps',
    'fixture.sub',
  ],
  tif: [
    'fixture-big-endian',
    'fixture-little-endian',
    'fixture-bali',
  ],
  png: [
    'fixture',
    'fixture-itxt',
  ],
  jxl: [
    'fixture',
    'fixture2',
  ],
  avif: [
    'fixture-yuv420-8bit',
    'fixture-sequence',
  ],
  heic: [
    'fixture-mif1',
    'fixture-msf1',
    'fixture-heic',
  ],
  pdf: [
    'fixture',
    'fixture-adobe-illustrator',
    'fixture-smallest',
    'fixture-fast-web',
    'fixture-printed',
    'fixture-minimal',
  ],
  cfb: [
    'fixture.msi',
    'fixture.xls',
    'fixture.doc',
    'fixture.ppt',
    'fixture-2.doc',
  ],
  asf: [
    'fixture',
    'fixture.wma',
    'fixture.wmv',
  ],
  tar: [
    'fixture',
    'fixture-v7',
    'fixture-spaces',
    'fixture-pax',
  ],
  mpc: [
    'fixture-sv7',
    'fixture-sv8',
  ],
  pcap: [
    'fixture-big-endian',
    'fixture-little-endian',
  ],
  woff: [
    'fixture',
    'fixture-otto',
  ],
  woff2: [
    'fixture',
    'fixture-otto',
  ],
  zip: [
    'fixture',
    'fixture2',
  ],
  macho: [
    'fixture-arm64',
    'fixture-x86_64',
    'fixture-i386',
    'fixture-ppc7400',
    'fixture-fat-binary',
  ],
  mts: [
    'fixture-raw',
    'fixture-bdav',
  ],
  webm: [
    'fixture-null',
  ],
  gz: [
    'fixture',
  ],
  xz: [
    'fixture.tar',
  ],
  lz: [
    'fixture.tar',
  ],
  Z: [
    'fixture.tar',
  ],
  zst: [
    'fixture.tar',
  ],
  lz4: [
    'fixture',
  ],
  cpio: [
    'fixture-bin',
    'fixture-ascii',
  ],
  eps: [
    'fixture',
    'fixture2',
  ],
};

// Fixtures that our detector returns a different MIME than what
// file-type would return, because our detection is intentionally
// coarser.  Map: "filename" → actual expected MIME from file_type.cpp
const overrides = {
  // ID3v2 header is detected as audio/mpeg (we don't peek past ID3 to find AAC/FLAC)
  'fixture-id3v2.aac': 'audio/mpeg',
  'fixture-id3v2.flac': 'audio/mpeg',
  // MPEG-TS → we detect correctly
  'fixture-raw.mts': 'video/mp2t',
  'fixture-bdav.mts': 'video/mp2t',
  // WebM is EBML → we return video/x-matroska (no WebM distinction)
  'fixture-null.webm': 'video/x-matroska',
  // EPS files start with %! → detected as application/postscript
  'fixture.eps': 'application/postscript',
  'fixture2.eps': 'application/postscript',
  // fixture.ps.mpg / fixture.sub.mpg start with MPEG signature
  'fixture.ps.mpg': 'video/mpeg',
  'fixture.sub.mpg': 'video/mpeg',
  // Compressed tar: we detect the outer wrapper
  'fixture.tar.xz': 'application/x-xz',
  'fixture.tar.lz': 'application/x-lzip',
  'fixture.tar.Z': 'application/x-compress',
  'fixture.tar.zst': 'application/zstd',
  // AVIF sequence uses "avis" ftyp brand
  'fixture-sequence.avif': 'image/avif',
  // HEIC brand mapping: mif1 → heif, msf1 → heif-sequence, heic → heic
  'fixture-mif1.heic': 'image/heif',
  'fixture-msf1.heic': 'image/heif-sequence',
  'fixture-heic.heic': 'image/heic',
};

// Build the fixture list following file-type's getFixtures() pattern
function getFixtures() {
  const fixtures = [];
  for (const [ext, mime] of Object.entries(types)) {
    if (Object.hasOwn(names, ext)) {
      for (const name of names[ext]) {
        const filename = `${name}.${ext}`;
        fixtures.push({ filename, ext, mime, path: path.join(FIXTURE, filename) });
      }
    } else {
      const filename = `fixture.${ext}`;
      fixtures.push({ filename, ext, mime, path: path.join(FIXTURE, filename) });
    }
  }
  return fixtures;
}

// -----------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------

// Image MIME prefixes → encoding will be 'image' (if stb can decode) or 'metadata'.
const isImageMime = (mime) => mime.startsWith('image/');

describe('MIME detection', () => {
  const fixtures = getFixtures();

  for (const f of fixtures) {
    const expectedMime = overrides[f.filename] ?? f.mime;

    test(`${f.filename} → ${expectedMime}`, () => {
      const timeout_ms = f.filename.includes('bdav') ? 30000 : 5000;
      const resp = rpc({ id: '1', tool: 'read', path: f.path }, { timeout_ms });
      assert.ok(!resp.error, `read error: ${resp.error}`);
      if (isImageMime(expectedMime)) {
        assert.ok(
          resp.encoding === 'image' || resp.encoding === 'metadata',
          `expected image or metadata encoding for ${f.filename}, got ${resp.encoding}`,
        );
      } else {
        assert.equal(resp.encoding, 'metadata',
          `expected metadata encoding for ${f.filename}, got ${resp.encoding}`);
      }
      assert.equal(resp.mime_type, expectedMime,
        `MIME mismatch for ${f.filename}: got ${resp.mime_type}, expected ${expectedMime}`);
    });
  }
});

// -----------------------------------------------------------------------
// Unsupported formats → should return application/octet-stream (binary)
// -----------------------------------------------------------------------

const unsupportedFixtures = [
  'fixture.blend',
  'fixture.bpg',
  'fixture.cab',
  'fixture.chm',
  'fixture.dcm',
  'fixture.dmg',
  'fixture.dsf',
  'fixture.fbx',
  'fixture.icc',
  'fixture.icns',
  'fixture.indd',
  'fixture.it',
  'fixture.ktx',
  'fixture.lnk',
  'fixture.lzh',
  'fixture.mobi',
  'fixture.mxf',
  'fixture.s3m',
  'fixture.sav',
  'fixture.xcf',
  'fixture.xm',
];

describe('unsupported formats → application/octet-stream', () => {
  for (const filename of unsupportedFixtures) {
    test(filename, () => {
      const resp = rpc({ id: '1', tool: 'read', path: path.join(FIXTURE, filename) });
      assert.ok(!resp.error, `read error: ${resp.error}`);
      assert.equal(resp.encoding, 'metadata', `expected metadata for ${filename}`);
      assert.equal(resp.mime_type, 'application/octet-stream',
        `expected octet-stream for unsupported ${filename}, got ${resp.mime_type}`);
    });
  }
});
