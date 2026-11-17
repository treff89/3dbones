# 3D Bones

**CT scan → 3D-printable bone model, entirely in your browser.**

Live site: **https://treff89.github.io/3dbones/**

Drop a CT study (a folder, loose DICOM files or a `.zip`) and download a watertight bone model as **STL** or **3MF**,
at true size in millimetres, ready for Bambu Studio and the Bambu Lab A1. Designed for the peripheral skeleton —
shoulder, elbow, wrist, hand — but it works on any CT.

> Not a medical device. For education, surgical-planning aids and patient communication only; not for diagnosis.
> Always check the model against the original images.

## Privacy: nothing is uploaded

* The site is a static page. All reading, anonymisation, segmentation and meshing happens in a Web Worker **on your device**.
* The page ships with a Content-Security-Policy of `connect-src 'none'`: the browser itself refuses every outgoing
  network request from the page and from its worker, so the scan *cannot* be sent anywhere. (You can verify this in the
  browser's developer tools → Network: after the page has loaded, nothing else is ever requested.)
* **Anonymisation happens as each file is read**, before any processing. A whitelist keeps only the technical
  attributes needed to build the volume (matrix size, pixel spacing, slice positions/orientation, rescale slope/intercept,
  kVp, reconstruction kernel, body part, cleaned series description). Everything else — patient name, ID, birth date,
  sex/age/weight, every date and time, accession and study numbers, institution, physicians, operators, device serial
  numbers, all UIDs, comments, private vendor tags — is discarded and never stored, shown or logged. Series descriptions
  that contain fragments of the patient's name or ID are blanked. File and folder names are never shown or exported.
* Images that may contain burned-in text (dose reports, screenshots, secondary captures) and scouts are skipped entirely.
* The exported STL/3MF contains geometry only. Its file name is generic (`bone-model.stl`).
* The anonymisation report in the side panel lists how many identifying fields were discarded, by category.
* Nothing is written to browser storage (no cookies, localStorage, IndexedDB, cache or service worker); the scan lives
  in the tab's memory and is gone when the tab closes.
* `test/e2e/privacy.mjs` audits a deployed copy in a real browser: it logs every network request made while a study
  is read, converted and downloaded (after the page's own three files have loaded there are none), tries to send data
  out from the page and from a worker by fetch, XHR, WebSocket, beacon and image (all blocked by the policy), checks
  storage, and searches the downloaded STL/3MF for planted identifiers.

What it cannot promise: GitHub, as the host, sees an ordinary page visit (IP address, browser) like any website — but
never the scan. Browser extensions you have installed can read any page. And the model you download is still derived
from a patient's anatomy; treat the file accordingly.

Note that a 3D surface of a *head* CT can itself be recognisable (face). That is not a concern for limbs.

## How it works

1. **Read & anonymise** (`src/dicom/`) — DICOM parsing (implicit/explicit VR, little/big endian, deflated), pixel decoding
   (uncompressed, RLE, JPEG Lossless, JPEG-LS, JPEG 2000, enhanced multi-frame CT), series grouping and automatic choice
   of the best series (thinnest slices, most coverage, original axial, sharp kernel). Scouts, dose reports and
   reformats are ignored or ranked down. Slices are sorted by position; gantry tilt, reversed order, missing slices and
   oblique acquisitions are handled geometrically, so the model is never mirrored or sheared.
2. **Focus** (`src/core/focus.js`) — real limb scans are rarely just the limb. The CT couch is removed (it lies
   outside the body), bones are grouped by proximity, and the group the scan was centred on is kept: for an arm scanned
   at the patient's side, the humerus, radius and ulna stay and the ribs and pelvis in the same field of view are left
   out. One checkbox shows everything again.
3. **Find the bone** — the kept region is resampled to an isotropic working grid (voxel size chosen from the anatomy
   size: ≈0.3 mm for a hand, ≈0.7 mm for a whole arm). The threshold comes from the scan's own histogram (soft-tissue
   peak + 175 HU, typically 200–230 HU). Noisy thin-slice scans get more smoothing rather than a higher threshold, so
   thin cortex is not lost. The slice view shows in orange exactly what will be printed.
4. **Make it printable** — specks, soft-tissue noise, contrast-filled vessels, splints, skin-marker wires and stray
   fragments are dropped; pinholes in thin cortex are sealed; marrow cavities are filled so bones are **solid** (the
   slicer decides infill) even when the cavity leaks to the outside somewhere; bones cut by the end of the scan get
   flat caps; joint spaces stay open; and separate bones are linked by short **pegs** so the model prints as one piece.
5. **Separate the bones** (`src/core/split.js`) — bones that touch across narrow joints (carpals, finger joints, the
   elbow) are split along the joint line, so each bone is its own piece that can be selected, removed or kept. A cut
   is only made where the CT shows a joint: a dark sheet between two plates of dense bone, each backed by marrow.
   Optional **metal removal** (`src/core/metal.js`) cuts plates, screws and nails out of the model.
6. **Mesh** — marching cubes on the Hounsfield field itself (sub-voxel accurate, no stair-steps), Taubin smoothing
   (no shrinkage), quadric decimation with a 0.06 mm error cap (meshoptimizer), strict manifold check, export.

Every step has an automatic default. The sliders (threshold, smoothing, detail, hole sealing, fragment size, pegs,
crop, scale) are for when you want something different. **Click bones in the preview to select them, then remove them
or keep only those** — e.g. print just the proximal humerus from a shoulder scan, or a single scaphoid.

Tested on public, de-identified CT series from The Cancer Imaging Archive (elbow/forearm, shoulder, hip, foot, chest,
PET/CT arms), on synthetic phantoms in every supported transfer syntax, and end-to-end in headless Chromium: a 450-slice
elbow CT goes from dropped folder to watertight STL in about 10 seconds.

## Printing on the Bambu A1

* **STL** is the default download: it opens in every slicer and Bambu Studio treats its units as millimetres.
  **3MF** is offered as well (smaller file, explicit units); Bambu Studio will note that it is “not from Bambu Lab” —
  choose to load the geometry.
* Model is exported 1 : 1. The preview shows the A1's 256 mm plate; if the model is too big the page offers the largest scale that fits.
* In Bambu Studio: *Auto orient* (or *Lay on face*), tree supports (auto), 0.16 mm layers, 3 walls, 10–15 % gyroid, PLA.
* Pegs are 3 mm by default (adjustable); cut them after printing if you want loose bones.

## Development

```bash
npm ci
npm run dev      # build + serve on http://localhost:8080, rebuilds on change
npm test         # unit tests (node --test)
npm run build    # production build into ./dist  (static files; deploy anywhere)
```

No patient data lives in this repository. Test fixtures under `test/fixtures/` are tiny synthetic phantoms with
fake identifiers (used to prove the anonymiser removes them).

```
src/dicom/    DICOM intake: parse, anonymise, decode, group series, assemble HU volume   (runs in the worker)
src/core/     resampling, auto-threshold, clean-up morphology, pegs, marching cubes, smoothing, decimation, STL/3MF
src/worker/   worker entry: message protocol between page and engine
src/app/      page, styles, 3D preview (three.js), controls
test/         unit tests; test/e2e/ (headless-browser run + STL checker) and test/manual/ need CT series, not committed
build.mjs     esbuild bundling; the worker is inlined into app.js so the page makes no runtime requests
```

Deployment: pushing to `main` runs the tests and publishes `dist/` to the `gh-pages` branch
(`.github/workflows/deploy.yml`), which GitHub Pages serves. The site is plain static files, so it can equally be
hosted on Cloudflare Pages (build command `npm run build`, output directory `dist`).

## Limits

* CT only (MR has no fixed bone intensity). Lossy JPEG-compressed CT (rare) is not decoded.
* A fixed threshold places the surface about 0.1–0.4 mm outside the true cortical edge (partial-volume effect) —
  negligible for anatomical models, but do not use the model for implant fit without checking.
* Bones that touch on the scan (narrow or arthritic joints, thick slices) come out as one piece; raise the threshold a
  little, or use the crop sliders, to separate them.
* Shoulder scans include ribs and spine, which usually fuse with the scapula at 1 mm slices: select the humerus and
  "keep only", or crop.
* Metal implants cause streak artefacts; raise the threshold or remove stray pieces by clicking them.
* Very thin bone (scapular blade, osteoporotic cortex) can fall below any threshold at coarse slice spacing — use the
  thinnest series, *Fine* detail, and lower the threshold a little.
* Plaster casts are as dense as bone; click them away if the automatic tidy-up does not.
* Needs a desktop-class browser with WebGL (Chrome, Edge, Firefox, Safari 16+). Large studies use 1–2 GB of memory.

## Licence

MIT. Third-party: three.js, dicom-parser, fflate, meshoptimizer, CharLS and OpenJPEG codec builds by Cornerstone
(all MIT/BSD).
