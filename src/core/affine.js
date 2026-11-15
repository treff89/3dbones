// Small helpers for the index <-> world (patient LPS mm) affine of a Volume / Work grid.

export function det3(a, b, c) {
  return a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0]);
}

export function len3(a) {
  return Math.hypot(a[0], a[1], a[2]);
}

/** Inverse of the 3x3 matrix whose COLUMNS are stepX, stepY, stepZ. Returns 9 numbers, row-major. */
export function invertSteps(sx, sy, sz) {
  const d = det3(sx, sy, sz);
  if (!d) throw new Error('degenerate voxel step vectors');
  // matrix M = [sx sy sz] (columns). inverse rows:
  const m00 = sx[0], m01 = sy[0], m02 = sz[0];
  const m10 = sx[1], m11 = sy[1], m12 = sz[1];
  const m20 = sx[2], m21 = sy[2], m22 = sz[2];
  return [
    (m11 * m22 - m12 * m21) / d, (m02 * m21 - m01 * m22) / d, (m01 * m12 - m02 * m11) / d,
    (m12 * m20 - m10 * m22) / d, (m00 * m22 - m02 * m20) / d, (m02 * m10 - m00 * m12) / d,
    (m10 * m21 - m11 * m20) / d, (m01 * m20 - m00 * m21) / d, (m00 * m11 - m01 * m10) / d,
  ];
}

/** World (LPS mm) -> continuous index coordinates [i,j,k] for a grid {origin, stepX, stepY, stepZ}. */
export function worldToIndex(grid, p) {
  const inv = invertSteps(grid.stepX, grid.stepY, grid.stepZ);
  const dx = p[0] - grid.origin[0], dy = p[1] - grid.origin[1], dz = p[2] - grid.origin[2];
  return [
    inv[0] * dx + inv[1] * dy + inv[2] * dz,
    inv[3] * dx + inv[4] * dy + inv[5] * dz,
    inv[6] * dx + inv[7] * dy + inv[8] * dz,
  ];
}

export function indexToWorld(grid, i, j, k) {
  const o = grid.origin, a = grid.stepX, b = grid.stepY, c = grid.stepZ;
  return [
    o[0] + i * a[0] + j * b[0] + k * c[0],
    o[1] + i * a[1] + j * b[1] + k * c[1],
    o[2] + i * a[2] + j * b[2] + k * c[2],
  ];
}
