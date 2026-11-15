// Indexed marching cubes over an Int16 field (positive = inside), grid padded by one outside layer.
import { edgeTable, triTable } from './mctables.js';

const PAD_VALUE = -150;

/**
 * @param F Int16Array field (nx*ny*nz), never exactly 0
 * @param labels Int32Array|null part labels (for vertexPart), same layout
 * @returns { positions: Float32Array (index coords, length 3*nv), indices: Uint32Array, vertexPart: Uint16Array, nv, nt }
 *   Triangles are wound counter-clockwise when seen from outside in INDEX space (right-handed index frame).
 */
export function marchingCubes(F, dims, labels = null) {
  const [nx, ny, nz] = dims;
  const PX = nx + 2, PY = ny + 2, PZ = nz + 2;
  const PP = PX * PY;
  let valA = new Float32Array(PP), valB = new Float32Array(PP);
  let qA = new Uint8Array(PP), qB = new Uint8Array(PP);
  let labA = new Int32Array(PP), labB = new Int32Array(PP);
  let exA = new Int32Array(PP).fill(-1), eyA = new Int32Array(PP).fill(-1);
  let exB = new Int32Array(PP).fill(-1), eyB = new Int32Array(PP).fill(-1);
  const ez = new Int32Array(PP).fill(-1);

  let vcap = 1 << 16, tcap = 1 << 17;
  let pos = new Float32Array(vcap * 3), vpart = new Uint16Array(vcap), idx = new Uint32Array(tcap * 3);
  let nv = 0, nt = 0;

  // load padded layer Z (0..PZ-1) into val / q / lab
  const loadLayer = (Z, val, q, lab) => {
    val.fill(PAD_VALUE);
    lab.fill(0);
    const z = Z - 1;
    if (z >= 0 && z < nz) {
      for (let y = 0; y < ny; y++) {
        const src = nx * (y + ny * z), dst = 1 + PX * (y + 1);
        for (let x = 0; x < nx; x++) val[dst + x] = F[src + x];
        if (labels) for (let x = 0; x < nx; x++) lab[dst + x] = labels[src + x];
      }
    }
    // quad codes: bit set = outside
    for (let Y = 0; Y < PY - 1; Y++) {
      let o = PX * Y;
      for (let X = 0; X < PX - 1; X++, o++) {
        q[o] = (val[o] < 0 ? 1 : 0) | (val[o + 1] < 0 ? 2 : 0) | (val[o + 1 + PX] < 0 ? 4 : 0) | (val[o + PX] < 0 ? 8 : 0);
      }
    }
  };

  const ev = new Int32Array(12);
  loadLayer(0, valA, qA, labA);
  for (let Z = 0; Z < PZ - 1; Z++) {
    loadLayer(Z + 1, valB, qB, labB);
    for (let Y = 0; Y < PY - 1; Y++) {
      let o = PX * Y;
      for (let X = 0; X < PX - 1; X++, o++) {
        const ci = qA[o] | (qB[o] << 4);
        if (ci === 0 || ci === 255) continue;
        const bits = edgeTable[ci];
        if (bits === 0) continue;
        if (nv + 12 > vcap) {
          vcap *= 2;
          const p2 = new Float32Array(vcap * 3); p2.set(pos); pos = p2;
          const v2 = new Uint16Array(vcap); v2.set(vpart); vpart = v2;
        }
        for (let e = 0; e < 12; e++) {
          if (!(bits & (1 << e))) continue;
          // edge -> buffer, endpoints (offsets within layer), axis
          let buf, key, oa, ob, layerA, layerB, axis;
          switch (e) {
            case 0: buf = exA; key = o; oa = o; ob = o + 1; layerA = 0; layerB = 0; axis = 0; break;
            case 1: buf = eyA; key = o + 1; oa = o + 1; ob = o + 1 + PX; layerA = 0; layerB = 0; axis = 1; break;
            case 2: buf = exA; key = o + PX; oa = o + PX; ob = o + PX + 1; layerA = 0; layerB = 0; axis = 0; break;
            case 3: buf = eyA; key = o; oa = o; ob = o + PX; layerA = 0; layerB = 0; axis = 1; break;
            case 4: buf = exB; key = o; oa = o; ob = o + 1; layerA = 1; layerB = 1; axis = 0; break;
            case 5: buf = eyB; key = o + 1; oa = o + 1; ob = o + 1 + PX; layerA = 1; layerB = 1; axis = 1; break;
            case 6: buf = exB; key = o + PX; oa = o + PX; ob = o + PX + 1; layerA = 1; layerB = 1; axis = 0; break;
            case 7: buf = eyB; key = o; oa = o; ob = o + PX; layerA = 1; layerB = 1; axis = 1; break;
            case 8: buf = ez; key = o; oa = o; ob = o; layerA = 0; layerB = 1; axis = 2; break;
            case 9: buf = ez; key = o + 1; oa = o + 1; ob = o + 1; layerA = 0; layerB = 1; axis = 2; break;
            case 10: buf = ez; key = o + 1 + PX; oa = o + 1 + PX; ob = o + 1 + PX; layerA = 0; layerB = 1; axis = 2; break;
            default: buf = ez; key = o + PX; oa = o + PX; ob = o + PX; layerA = 0; layerB = 1; axis = 2; break;
          }
          let vi = buf[key];
          if (vi < 0) {
            const va = layerA ? valB[oa] : valA[oa];
            const vb = layerB ? valB[ob] : valA[ob];
            const t = va / (va - vb);
            const ax = oa % PX, ay = (oa / PX) | 0;
            let px = ax - 1, py = ay - 1, pz = Z - 1 + layerA;
            if (axis === 0) px += t; else if (axis === 1) py += t; else pz += t;
            vi = nv++;
            pos[vi * 3] = px; pos[vi * 3 + 1] = py; pos[vi * 3 + 2] = pz;
            let part = 0;
            if (labels) part = va > 0 ? (layerA ? labB[oa] : labA[oa]) : (layerB ? labB[ob] : labA[ob]);
            vpart[vi] = part > 65535 ? 65535 : part;
            buf[key] = vi;
          }
          ev[e] = vi;
        }
        const tb = ci << 4;
        if (nt + 5 > tcap) { tcap *= 2; const i2 = new Uint32Array(tcap * 3); i2.set(idx); idx = i2; }
        for (let k = 0; triTable[tb + k] !== -1; k += 3) {
          // table order is counter-clockwise seen from outside (with bit set = outside)
          idx[nt * 3] = ev[triTable[tb + k]];
          idx[nt * 3 + 1] = ev[triTable[tb + k + 1]];
          idx[nt * 3 + 2] = ev[triTable[tb + k + 2]];
          nt++;
        }
      }
    }
    // swap layers
    let t;
    t = valA; valA = valB; valB = t;
    t = qA; qA = qB; qB = t;
    t = labA; labA = labB; labB = t;
    t = exA; exA = exB; exB = t; exB.fill(-1);
    t = eyA; eyA = eyB; eyB = t; eyB.fill(-1);
    ez.fill(-1);
  }
  return {
    positions: pos.subarray(0, nv * 3), indices: idx.subarray(0, nt * 3), vertexPart: vpart.subarray(0, nv), nv, nt,
  };
}
