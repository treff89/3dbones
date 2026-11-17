// 3D preview: bone mesh on a Bambu A1-sized build plate, orbit controls, click-to-pick parts.
import {
  AmbientLight, BufferAttribute, BufferGeometry, DirectionalLight, DoubleSide, GridHelper, Group,
  HemisphereLight, LineBasicMaterial, LineSegments, Mesh, MeshStandardMaterial, PerspectiveCamera, Raycaster,
  Scene, SRGBColorSpace, Vector2, Vector3, WebGLRenderer, Box3, EdgesGeometry, BoxGeometry,
} from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

export const BED_MM = 256; // Bambu Lab A1 build volume is 256 × 256 × 256 mm

const BONE = [0.93, 0.89, 0.8];
// Muted tints for telling separate pieces apart (bone-ish, so the model still reads as a skeleton)
const TINTS = [
  [0.93, 0.89, 0.80], [0.80, 0.87, 0.93], [0.95, 0.80, 0.74], [0.82, 0.92, 0.80], [0.93, 0.85, 0.62], [0.86, 0.80, 0.93],
  [0.74, 0.90, 0.88], [0.96, 0.78, 0.86], [0.88, 0.93, 0.68], [0.78, 0.82, 0.96], [0.97, 0.83, 0.66], [0.80, 0.94, 0.74],
];
const PEG = [0.42, 0.66, 0.95];
const PICK = [1.0, 0.62, 0.2];

export class Viewer {
  constructor(container) {
    this.container = container;
    this.onPick = null;
    this.scale = 1;
    this.mesh = null;
    this.vertexPart = null;
    this.highlight = new Set(); // part ids drawn in the selection colour
    this.tint = true; // give each separate piece its own tint
    this.firstFrame = true;

    const renderer = new WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.outputColorSpace = SRGBColorSpace;
    container.appendChild(renderer.domElement);
    this.renderer = renderer;

    const scene = new Scene();
    this.scene = scene;
    const camera = new PerspectiveCamera(32, 1, 1, 5000);
    camera.up.set(0, 0, 1);
    camera.position.set(0, -420, 220);
    this.camera = camera;

    scene.add(new HemisphereLight(0xffffff, 0x3a4250, 1.15));
    scene.add(new AmbientLight(0xffffff, 0.25));
    // Key + fill lights ride with the camera so the surface relief stays readable from any angle.
    const key = new DirectionalLight(0xffffff, 1.9);
    key.position.set(-0.6, 0.9, 1.2);
    const fill = new DirectionalLight(0xbfd4ff, 0.55);
    fill.position.set(1, -0.4, 0.6);
    camera.add(key, fill);
    scene.add(camera);

    // Build plate: 256 mm square with a 16 mm grid, in the z = 0 plane.
    const bed = new Group();
    const grid = new GridHelper(BED_MM, 16, 0x4a5568, 0x2b3340);
    grid.rotation.x = Math.PI / 2;
    bed.add(grid);
    const frame = new LineSegments(
      new EdgesGeometry(new BoxGeometry(BED_MM, BED_MM, BED_MM)),
      new LineBasicMaterial({ color: 0x2f3947, transparent: true, opacity: 0.55 }),
    );
    frame.position.z = BED_MM / 2;
    bed.add(frame);
    scene.add(bed);
    this.bed = bed;

    this.material = new MeshStandardMaterial({
      vertexColors: true, roughness: 0.62, metalness: 0.02, side: DoubleSide,
    });
    this.root = new Group();
    scene.add(this.root);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.12;
    controls.rotateSpeed = 0.9;
    controls.zoomSpeed = 1.1;
    controls.minDistance = 10;
    controls.maxDistance = 2500;
    controls.target.set(0, 0, 60);
    controls.addEventListener('change', () => this.requestRender());
    this.controls = controls;

    // Click (without drag) picks a part.
    let down = null;
    const el = renderer.domElement;
    el.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY, t: performance.now() }; });
    el.addEventListener('pointerup', (e) => {
      if (!down) return;
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
      const quick = performance.now() - down.t < 600;
      down = null;
      if (moved < 5 && quick && e.button === 0) this.pick(e);
    });

    this.raycaster = new Raycaster();
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
    this.needsRender = true;
    const loop = () => {
      requestAnimationFrame(loop);
      if (this.controls.update() || this.needsRender) {
        this.needsRender = false;
        this.renderer.render(this.scene, this.camera);
      }
    };
    loop();
  }

  requestRender() { this.needsRender = true; }

  resize() {
    const w = Math.max(50, this.container.clientWidth);
    const h = Math.max(50, this.container.clientHeight);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.requestRender();
  }

  clear() {
    if (this.mesh) {
      this.root.remove(this.mesh);
      this.mesh.geometry.dispose();
      this.mesh = null;
    }
    this.vertexPart = null;
    this.firstFrame = true;
    this.requestRender();
  }

  // mesh: {positions Float32Array (mm, print coords, bbox min = 0), indices Uint32Array, vertexPart Uint16Array}
  setMesh(mesh, { keepCamera = true } = {}) {
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(mesh.positions, 3));
    geometry.setIndex(new BufferAttribute(mesh.indices, 1));
    geometry.computeVertexNormals();
    const colors = new Float32Array(mesh.positions.length);
    geometry.setAttribute('color', new BufferAttribute(colors, 3));
    geometry.computeBoundingBox();
    this.vertexPart = mesh.vertexPart;

    if (this.mesh) {
      this.root.remove(this.mesh);
      this.mesh.geometry.dispose();
    }
    this.mesh = new Mesh(geometry, this.material);
    this.root.add(this.mesh);
    this.highlight = new Set();
    this.paint();
    this.layout();
    const size = geometry.boundingBox.getSize(new Vector3()).length();
    if (this.firstFrame || !keepCamera) {
      this.firstFrame = false;
      this.setView('front');
    } else if (this.lastSize && (size < this.lastSize * 0.7 || size > this.lastSize * 1.4)) {
      this.refit(); // the model changed extent (pieces removed / isolated): re-frame, same viewing direction
    }
    this.lastSize = size;
    this.requestRender();
  }

  // Centre the model on the plate, resting on z = 0, at the current print scale.
  layout() {
    if (!this.mesh) return;
    const bb = this.mesh.geometry.boundingBox;
    const s = this.scale;
    this.mesh.scale.setScalar(s);
    this.mesh.position.set(
      -s * (bb.min.x + bb.max.x) / 2,
      -s * (bb.min.y + bb.max.y) / 2,
      -s * bb.min.z,
    );
    this.mesh.updateMatrixWorld(true);
    this.requestRender();
  }

  setScale(scale) {
    this.scale = scale;
    this.layout();
  }

  paint() {
    if (!this.mesh) return;
    const colors = this.mesh.geometry.getAttribute('color');
    const arr = colors.array;
    const part = this.vertexPart;
    const hl = this.highlight;
    for (let v = 0, n = arr.length / 3; v < n; v++) {
      const p = part ? part[v] : 1;
      const c = hl.has(p) ? PICK : p === 0 ? PEG : this.tint ? TINTS[(p - 1) % TINTS.length] : BONE;
      arr[3 * v] = c[0]; arr[3 * v + 1] = c[1]; arr[3 * v + 2] = c[2];
    }
    colors.needsUpdate = true;
    this.requestRender();
  }

  setTint(on) {
    this.tint = !!on;
    this.paint();
  }

  setHighlight(partIds) {
    this.highlight = new Set(partIds || []);
    this.paint();
  }

  pick(event) {
    if (!this.mesh || !this.onPick) return;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(ndc, this.camera);
    const hits = this.raycaster.intersectObject(this.mesh, false);
    if (!hits.length) {
      this.onPick(null);
      return;
    }
    const hit = hits[0];
    const f = hit.face;
    // Majority vote over the triangle's three vertices; prefer a real part over a peg.
    const ids = [this.vertexPart[f.a], this.vertexPart[f.b], this.vertexPart[f.c]];
    let id = ids[0] === ids[1] || ids[0] === ids[2] ? ids[0] : ids[1] === ids[2] ? ids[1] : ids[0];
    if (id === 0) id = ids.find((x) => x !== 0) || 0;
    this.onPick({ partId: id, clientX: event.clientX, clientY: event.clientY });
  }

  // Re-centre and re-zoom on the model without changing the viewing direction.
  refit() {
    if (!this.mesh) return;
    const box = new Box3().setFromObject(this.mesh);
    const centre = box.getCenter(new Vector3());
    const radius = Math.max(20, box.getSize(new Vector3()).length() / 2);
    const dist = (radius / Math.sin((this.camera.fov * Math.PI) / 360)) * 1.05;
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    this.camera.position.copy(centre).addScaledVector(dir, dist);
    this.camera.near = Math.max(0.5, dist / 200);
    this.camera.far = dist * 20 + 2000;
    this.camera.updateProjectionMatrix();
    this.controls.target.copy(centre);
    this.controls.update();
    this.requestRender();
  }

  // Patient-based views: x = patient left, y = posterior, z = head.
  setView(name) {
    const box = new Box3();
    if (this.mesh) box.setFromObject(this.mesh);
    else box.set(new Vector3(-60, -60, 0), new Vector3(60, 60, 120));
    const centre = box.getCenter(new Vector3());
    const size = box.getSize(new Vector3());
    const radius = Math.max(20, size.length() / 2);
    const dist = (radius / Math.sin((this.camera.fov * Math.PI) / 360)) * 1.05;
    const dirs = {
      front: [0, -1, 0.18], back: [0, 1, 0.18], left: [1, 0, 0.18], right: [-1, 0, 0.18],
      top: [0, -0.001, 1], bottom: [0, -0.001, -1], iso: [-0.75, -1, 0.7],
    };
    const d = new Vector3(...(dirs[name] || dirs.front)).normalize();
    this.camera.position.copy(centre).addScaledVector(d, dist);
    this.camera.near = Math.max(0.5, dist / 200);
    this.camera.far = dist * 20 + 2000;
    this.camera.updateProjectionMatrix();
    this.controls.target.copy(centre);
    this.controls.update();
    this.requestRender();
  }

  snapshot() {
    this.renderer.render(this.scene, this.camera);
    return this.renderer.domElement.toDataURL('image/png');
  }
}


