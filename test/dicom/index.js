// Allows `node --test test/dicom/` on Node 22 (which resolves a directory argument to its index.js).
// Plain `node --test` also finds the *.test.js files directly.
import './loader.test.js';
import './units.test.js';
