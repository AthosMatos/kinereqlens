// Packages the built extension for the Edge Add-ons / Chrome Web Store: a plain ZIP (deflate, CRC-32,
// central directory) written with node:zlib only. The packaged manifest.json has no "key": that field only pins the
// unpacked build's id (static/manifest.json), the stores assign their own id and reject or ignore a key in uploads.
//
//   node scripts/zip.mjs                         -> dist/ -> reqlens-<version>.zip (project root)
//   node scripts/zip.mjs --src <dir> --out <file> -> any folder (must contain manifest.json)
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import zlib from 'node:zlib';

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Files that never belong in a store package. */
function isJunk(name) {
  return name.startsWith('.') || name === 'Thumbs.db' || name.endsWith('.map');
}

/** Relative POSIX paths of every file under `dir`, sorted for reproducible archives. */
export async function listFiles(dir, prefix = '') {
  const out = [];
  const entries = await readdir(path.join(dir, prefix), { withFileTypes: true });
  for (const entry of entries) {
    if (isJunk(entry.name)) continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...(await listFiles(dir, rel)));
    else if (entry.isFile()) out.push(rel);
  }
  return out.sort();
}

/** MS-DOS date/time fields (local time, 2-second resolution, 1980..2107). */
function dosDateTime(date) {
  const year = Math.min(Math.max(date.getFullYear(), 1980), 2107);
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

/**
 * Build a ZIP archive. `files` = [{ name, data: Buffer, mtime: Date }]. Each entry is deflated unless
 * that does not make it smaller (then stored). No ZIP64: refuses archives that would need it.
 */
export function buildZip(files) {
  if (files.length > 0xffff) throw new Error('Too many files for a non-ZIP64 archive');
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8');
    const deflated = zlib.deflateRawSync(file.data, { level: 9 });
    const useDeflate = deflated.length < file.data.length;
    const payload = useDeflate ? deflated : file.data;
    const crc = crc32(file.data);
    const { time, date } = dosDateTime(file.mtime);
    if (file.data.length > 0xfffffffe || offset > 0xfffffffe) throw new Error('Archive too large for non-ZIP64 format');

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // local file header signature
    local.writeUInt16LE(20, 4); // version needed (2.0: deflate)
    local.writeUInt16LE(0x0800, 6); // flags: UTF-8 names
    local.writeUInt16LE(useDeflate ? 8 : 0, 8); // method
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(file.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // extra length
    locals.push(local, name, payload);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); // central directory signature
    central.writeUInt16LE((3 << 8) | 20, 4); // made by: Unix, spec 2.0
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(useDeflate ? 8 : 0, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(file.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30); // extra length
    central.writeUInt16LE(0, 32); // comment length
    central.writeUInt16LE(0, 34); // disk number
    central.writeUInt16LE(0, 36); // internal attributes
    central.writeUInt32LE(((0o100644 << 16) >>> 0) >>> 0, 38); // external attributes: regular file rw-r--r--
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + payload.length;
  }

  const centralSize = centrals.reduce((sum, b) => sum + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); // end of central directory signature
  end.writeUInt16LE(0, 4); // this disk
  end.writeUInt16LE(0, 6); // disk with central directory
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20); // comment length
  return Buffer.concat([...locals, ...centrals, end]);
}

/** manifest.json text as the stores take it: without "key" (unchanged when it has none). */
export function storeManifest(text) {
  const manifest = JSON.parse(text);
  if (!Object.hasOwn(manifest, 'key')) return text;
  delete manifest.key;
  return JSON.stringify(manifest, null, 2);
}

/** The files of `srcDir` as they go into the store package ([{ name, data, mtime }], manifest without "key"). */
export async function packageFiles(srcDir) {
  const names = await listFiles(srcDir);
  if (!names.includes('manifest.json')) throw new Error(`${srcDir} has no manifest.json — run "npm run build" first`);
  const files = [];
  for (const name of names) {
    const full = path.join(srcDir, name);
    const [raw, info] = await Promise.all([readFile(full), stat(full)]);
    const data = name === 'manifest.json' ? Buffer.from(storeManifest(raw.toString('utf8')), 'utf8') : raw;
    files.push({ name, data, mtime: info.mtime });
  }
  return files;
}

/** Zip every file of `srcDir` into `outFile` (manifest without "key"). Resolves with the list of archived paths. */
export async function zipDirectory(srcDir, outFile) {
  const files = await packageFiles(srcDir);
  await writeFile(outFile, buildZip(files));
  return files.map((file) => file.name);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (key === '--src' || key === '--out') {
      const value = argv[++i];
      if (!value) throw new Error(`${key} needs a value`);
      args[key.slice(2)] = value;
    } else {
      throw new Error(`Unknown argument: ${key}`);
    }
  }
  return args;
}

async function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const args = parseArgs(process.argv.slice(2));
  const srcDir = path.resolve(args.src ?? path.join(root, 'dist'));
  let outFile = args.out;
  if (!outFile) {
    const manifest = JSON.parse(await readFile(path.join(srcDir, 'manifest.json'), 'utf8'));
    const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
    outFile = path.join(root, `reqlens-${manifest.version || pkg.version}.zip`);
  }
  outFile = path.resolve(outFile);
  const names = await zipDirectory(srcDir, outFile);
  const { size } = await stat(outFile);
  const shown = path.relative(root, outFile);
  console.log(`[reqlens] ${shown.startsWith('..') ? outFile : shown}: ${names.length} files, ${size} bytes (manifest without "key")`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((err) => {
    console.error(`[reqlens] zip failed: ${err.message}`);
    process.exitCode = 1;
  });
}
