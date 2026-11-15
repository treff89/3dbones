// 3dbones DICOM intake module — public entry point.
// Runs unchanged in a browser Web Worker and in Node (no DOM, no fs).
export { StudyLoader } from './loader.js';
export { setWasmBinaries } from './codecs.js';
export { TRANSFER_SYNTAXES } from './transfer-syntax.js';
