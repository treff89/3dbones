// Binary STL and minimal 3MF export.
import { Zip, ZipDeflate, ZipPassThrough, gzipSync, gunzipSync } from 'fflate';

export function exportSTL(mesh, { scale = 1, header = '3dbones anonymised bone model' } = {}) {
  const P = mesh.positions, I = mesh.indices;
  const nt = I.length / 3;
  const buf = new ArrayBuffer(84 + 50 * nt);
  const u8 = new Uint8Array(buf);
  const dv = new DataView(buf);
  const h = new TextEncoder().encode(header.slice(0, 80));
  u8.set(h.subarray(0, 80), 0);
  dv.setUint32(80, nt, true);
  let o = 84;
  for (let t = 0; t < nt; t++, o += 50) {
    const a = 3 * I[3 * t], b = 3 * I[3 * t + 1], c = 3 * I[3 * t + 2];
    const ax = P[a] * scale, ay = P[a + 1] * scale, az = P[a + 2] * scale;
    const bx = P[b] * scale, by = P[b + 1] * scale, bz = P[b + 2] * scale;
    const cx = P[c] * scale, cy = P[c + 1] * scale, cz = P[c + 2] * scale;
    const ux = bx - ax, uy = by - ay, uz = bz - az, vx = cx - ax, vy = cy - ay, vz = cz - az;
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
    nx /= l; ny /= l; nz /= l;
    dv.setFloat32(o, nx, true); dv.setFloat32(o + 4, ny, true); dv.setFloat32(o + 8, nz, true);
    dv.setFloat32(o + 12, ax, true); dv.setFloat32(o + 16, ay, true); dv.setFloat32(o + 20, az, true);
    dv.setFloat32(o + 24, bx, true); dv.setFloat32(o + 28, by, true); dv.setFloat32(o + 32, bz, true);
    dv.setFloat32(o + 36, cx, true); dv.setFloat32(o + 40, cy, true); dv.setFloat32(o + 44, cz, true);
    // attribute byte count stays 0
  }
  return u8;
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
</Types>`;

const RELS = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>`;

function xmlEscape(s) {
  return String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]);
}

function fmt(v) {
  // up to 4 decimals, no exponent notation
  const r = Math.round(v * 10000) / 10000;
  return r === 0 ? '0' : String(r);
}

export function export3MF(mesh, { scale = 1, name = 'bone' } = {}) {
  const P = mesh.positions, I = mesh.indices;
  const nv = P.length / 3, nt = I.length / 3;
  const chunks = [];
  let err = null;
  const zip = new Zip((e, data) => { if (e) err = e; else chunks.push(data); });
  const enc = new TextEncoder();
  const addSmall = (path, text) => {
    const f = new ZipPassThrough(path);
    zip.add(f);
    f.push(enc.encode(text), true);
  };
  addSmall('[Content_Types].xml', CONTENT_TYPES);
  addSmall('_rels/.rels', RELS);
  const model = new ZipDeflate('3D/3dmodel.model', { level: 6 });
  zip.add(model);
  model.push(enc.encode(
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">\n' +
    '<metadata name="Application">3dbones</metadata>\n' +
    `<resources>\n<object id="1" type="model" name="${xmlEscape(name)}">\n<mesh>\n<vertices>\n`), false);
  const CH = 20000;
  for (let v0 = 0; v0 < nv; v0 += CH) {
    let s = '';
    const e = Math.min(nv, v0 + CH);
    for (let v = v0; v < e; v++) s += `<vertex x="${fmt(P[3 * v] * scale)}" y="${fmt(P[3 * v + 1] * scale)}" z="${fmt(P[3 * v + 2] * scale)}"/>\n`;
    model.push(enc.encode(s), false);
  }
  model.push(enc.encode('</vertices>\n<triangles>\n'), false);
  for (let t0 = 0; t0 < nt; t0 += CH) {
    let s = '';
    const e = Math.min(nt, t0 + CH);
    for (let t = t0; t < e; t++) s += `<triangle v1="${I[3 * t]}" v2="${I[3 * t + 1]}" v3="${I[3 * t + 2]}"/>\n`;
    model.push(enc.encode(s), false);
  }
  model.push(enc.encode('</triangles>\n</mesh>\n</object>\n</resources>\n<build>\n<item objectid="1"/>\n</build>\n</model>\n'), true);
  zip.end();
  if (err) throw err;
  let len = 0;
  for (const c of chunks) len += c.length;
  const out = new Uint8Array(len);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

/**
 * Anonymised volume export: the working grid as a gzip-compressed NRRD file (opens in 3D Slicer, ITK-SNAP, MITK).
 * It holds Hounsfield values and geometry ONLY - there is no DICOM header to leak: no names, dates, IDs or UIDs.
 * @param grid { dims, hu|data: Int16Array, origin, stepX, stepY, stepZ }
 */
export function exportNRRD(grid, { level = 6 } = {}) {
  const hu = grid.hu || grid.data;
  const v = (a) => `(${a.map((x) => Number(x.toFixed(6))).join(',')})`;
  const header = [
    'NRRD0004',
    '# 3D Bones anonymised CT volume: Hounsfield units and geometry only',
    'type: short',
    'dimension: 3',
    'space: left-posterior-superior',
    `sizes: ${grid.dims.join(' ')}`,
    `space directions: ${v(grid.stepX)} ${v(grid.stepY)} ${v(grid.stepZ)}`,
    'kinds: domain domain domain',
    'endian: little',
    'encoding: gzip',
    `space origin: ${v(grid.origin)}`,
    '', '',
  ].join('\n');
  const head = new TextEncoder().encode(header);
  const raw = new Uint8Array(hu.buffer, hu.byteOffset, hu.byteLength); // typed arrays are little-endian on every browser platform
  const body = gzipSync(raw, { level });
  const out = new Uint8Array(head.length + body.length);
  out.set(head, 0);
  out.set(body, head.length);
  return out;
}

/** Read back a file written by exportNRRD (gzip or raw encoding, short, 3D) as a Volume-like grid. */
export function importNRRD(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let end = -1;
  for (let i = 0; i + 1 < u8.length && i < 65536; i++) if (u8[i] === 10 && u8[i + 1] === 10) { end = i; break; }
  if (end < 0) throw new Error('not an NRRD file');
  const fields = {};
  for (const line of new TextDecoder().decode(u8.subarray(0, end)).split('\n')) {
    const m = /^([^#:][^:]*):\s*(.*)$/.exec(line);
    if (m) fields[m[1].trim().toLowerCase()] = m[2].trim();
  }
  if (!/^(short|int16|signed short|short int)/.test(fields.type || '') || fields.dimension !== '3') throw new Error('only 3D 16-bit NRRD volumes are supported');
  const dims = fields.sizes.split(/\s+/).map(Number);
  const vecs = (fields['space directions'] || '').match(/\(([^)]*)\)/g).map((t) => t.slice(1, -1).split(',').map(Number));
  const origin = fields['space origin'].slice(1, -1).split(',').map(Number);
  let body = u8.subarray(end + 2);
  if (/gz/.test(fields.encoding || 'raw')) body = gunzipSync(body);
  const data = new Int16Array(body.buffer.slice(body.byteOffset, body.byteOffset + dims[0] * dims[1] * dims[2] * 2));
  const [stepX, stepY, stepZ] = vecs;
  return { dims, data, origin, stepX, stepY, stepZ, spacing: vecs.map((a) => Math.hypot(...a)) };
}
