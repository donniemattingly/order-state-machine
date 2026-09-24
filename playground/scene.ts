import * as THREE from "three";
import type { OrderSnapshot, State } from "../index";

type Name = State["state"];
export type SceneChoice = { target: Name | "fail_fulfillment"; label: string; choose: () => void };
const layout: Record<Name, [number, number, number]> = {
  initialized: [-6.5, 1.7, 0], payment_authorized: [0, 1.7, 0], complete: [6.5, 1.7, 0],
  rejected: [-6.5, -2, .5], cancelled: [0, -2, .5], needs_attention: [6.5, -2, .5],
};
const links: [Name, Name][] = [
  ["initialized", "payment_authorized"], ["payment_authorized", "complete"],
  ["initialized", "rejected"], ["payment_authorized", "cancelled"],
  ["payment_authorized", "needs_attention"],
];
const colorFor = (name: Name) => name === "needs_attention" || name === "rejected" ? 0xb97755 : name === "cancelled" ? 0xb49758 : 0x477b5c;

/** Projects snapshots and calls supplied UI actions; never mutates domain state. */
export function createStateScene(host: HTMLElement) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setClearColor(0x080f19, 0);
  renderer.domElement.setAttribute("aria-label", "Order state graph. Choose highlighted destinations using the buttons on the graph.");
  renderer.domElement.setAttribute("role", "img");
  host.prepend(renderer.domElement);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(43, 1, .1, 100);
  const home = () => {
    camera.position.set(0, 2.8, host.clientWidth < 600 ? 26 : 13);
    camera.lookAt(0, 0, 0);
  };
  home();
  scene.add(new THREE.AmbientLight(0xbed7ff, 2));
  const keyLight = new THREE.DirectionalLight(0xffffff, 3);
  keyLight.position.set(1, 5, 8);
  scene.add(keyLight);
  const rim = new THREE.PointLight(0x55c9ff, 30);
  rim.position.set(-4, 2, 4);
  scene.add(rim);

  const nodes = new Map<Name, { orb: THREE.Mesh<THREE.IcosahedronGeometry, THREE.MeshStandardMaterial>; ring: THREE.Mesh<THREE.TorusGeometry, THREE.MeshBasicMaterial>; label: HTMLButtonElement; position: THREE.Vector3 }>();
  for (const [name, xyz] of Object.entries(layout) as [Name, [number, number, number]][]) {
    const position = new THREE.Vector3(...xyz);
    if (host.clientWidth < 600) position.y = xyz[1] > 0 ? 3.5 : -3.5;
    const orb = new THREE.Mesh(new THREE.IcosahedronGeometry(.45, 2), new THREE.MeshStandardMaterial({ color: 0xafbdaf, metalness: .55, roughness: .25, emissive: colorFor(name), emissiveIntensity: .05, flatShading: true }));
    orb.position.copy(position);
    scene.add(orb);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(.63, .018, 8, 64), new THREE.MeshBasicMaterial({ color: 0xafbdaf }));
    ring.position.copy(position);
    scene.add(ring);
    const label = document.createElement("button");
    label.type = "button";
    label.dataset.state = name;
    label.disabled = true;
    label.className = "scene-label";
    const title = document.createElement("strong");
    title.textContent = ({ initialized: "Initialized", payment_authorized: "Payment authorized", complete: "Complete", rejected: "Rejected", cancelled: "Cancelled", needs_attention: "Needs attention" }[name]);
    const badge = document.createElement("span");
    badge.textContent = "Unvisited";
    label.append(title, badge);
    host.append(label);
    nodes.set(name, { orb, ring, label, position });
  }
  const failureButton = document.createElement("button");
  failureButton.className = "failure-choice";
  failureButton.hidden = true;
  host.append(failureButton);
  const edges = links.map(([from, to]) => {
    const start = nodes.get(from)!.position;
    const end = nodes.get(to)!.position;
    const mid = start.clone().lerp(end, .5);
    mid.z -= from === "payment_authorized" && to === "needs_attention" ? 1.1 : .35;
    const curve = new THREE.QuadraticBezierCurve3(start, mid, end);
    const material = new THREE.MeshBasicMaterial({ color: 0xb0bfb0, transparent: true, opacity: .7 });
    const mesh = new THREE.Mesh(new THREE.TubeGeometry(curve, 48, .022, 6, false), material);
    scene.add(mesh);
    const arrow = new THREE.Mesh(new THREE.ConeGeometry(.10, .25, 8), new THREE.MeshBasicMaterial({ color: 0x8c9f8d }));
    arrow.position.copy(curve.getPoint(.73));
    arrow.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), curve.getTangent(.73).normalize());
    scene.add(arrow);
    return { from, to, curve, material, arrow };
  });
  const marker = new THREE.Mesh(new THREE.SphereGeometry(.15, 20, 12), new THREE.MeshBasicMaterial({ color: 0x263e2f }));
  scene.add(marker);
  const halo = new THREE.Mesh(new THREE.SphereGeometry(.26, 20, 12), new THREE.MeshBasicMaterial({ color: 0x477b5c, transparent: true, opacity: .16, depthWrite: false }));
  marker.add(halo);

  let active: Name = "initialized";
  let orderId = "";
  let pending = false;
  let movement: { curve: THREE.QuadraticBezierCurve3; began: number } | undefined;
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
  const update = (snapshot: OrderSnapshot, busy: boolean, choices: SceneChoice[] = []) => {
    const failure = choices.find(choice => choice.target === "fail_fulfillment");
    failureButton.hidden = !failure;
    failureButton.textContent = failure?.label ?? "";
    failureButton.onclick = failure?.choose ?? null;
    const previous = active;
    active = snapshot.state;
    pending = busy;
    const changedOrder = orderId !== snapshot.id;
    orderId = snapshot.id;
    const edge = edges.find(edge => edge.from === previous && edge.to === active);
    if (!changedOrder && previous !== active && edge && !reduced.matches) movement = { curve: edge.curve, began: performance.now() };
    else if (changedOrder || reduced.matches) movement = undefined;
    for (const [name, node] of nodes) {
      const visited = snapshot.history.some(entry => entry.state === name);
      node.orb.material.color.setHex(visited ? colorFor(name) : 0xafbdaf);
      node.orb.material.emissiveIntensity = name === active ? .15 : .02;
      node.ring.material.color.setHex(visited ? colorFor(name) : 0xafbdaf);
      node.label.classList.toggle("is-current", name === active);
      node.label.classList.toggle("is-visited", visited);
      const choice = choices.find(choice => choice.target === name);
      node.label.disabled = !choice;
      node.label.onclick = choice?.choose ?? null;
      node.label.classList.toggle("is-choice", !!choice);
      node.label.setAttribute("aria-label", choice ? choice.label : `${name.replaceAll("_", " ")} · ${name === active ? "current state" : visited ? "visited" : "unvisited"}`);
      node.label.querySelector("span")!.textContent = choice ? `${choice.label} →` : name === active ? "You are here" : visited ? "Visited" : "";
      if (choice) node.ring.material.color.setHex(colorFor(name));
    }
    for (const edge of edges) {
      const traveled = snapshot.history.some((entry, i) => i > 0 && entry.state === edge.to && snapshot.history[i - 1]!.state === edge.from);
      edge.material.color.setHex(traveled ? colorFor(edge.to) : 0xb0bfb0);
      edge.material.opacity = traveled ? 1 : .6;
      edge.arrow.material.color.setHex(traveled ? colorFor(edge.to) : 0x8c9f8d);
    }
  };
  const resize = new ResizeObserver(() => {
    const width = host.clientWidth, height = host.clientHeight;
    renderer.setSize(width, height);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  });
  resize.observe(host);
  renderer.setAnimationLoop((time) => {
    if (document.hidden) return;
    const node = nodes.get(active)!;
    if (movement) {
      const progress = Math.min((performance.now() - movement.began) / 850, 1);
      marker.position.copy(movement.curve.getPoint(progress * progress * (3 - 2 * progress)));
      if (progress === 1) movement = undefined;
    } else marker.position.copy(node.position).add(new THREE.Vector3(0, .55, .1));
    halo.scale.setScalar(!reduced.matches && pending ? 1 + .25 * Math.sin(time / 180) : 1);
    const failurePosition = new THREE.Vector3(3.25, host.clientWidth < 600 ? -1.8 : -.4, .5).project(camera);
    failureButton.style.left = `${(failurePosition.x * .5 + .5) * host.clientWidth}px`;
    failureButton.style.top = `${(-failurePosition.y * .5 + .5) * host.clientHeight}px`;
    for (const [name, item] of nodes) {
      item.ring.scale.setScalar(name === active ? 1.2 : 1);
      const projected = item.position.clone().project(camera);
      item.label.style.left = `${(projected.x * .5 + .5) * host.clientWidth}px`;
      item.label.style.top = `${(-projected.y * .5 + .5) * host.clientHeight}px`;
      item.label.hidden = projected.z > 1;
    }
    renderer.render(scene, camera);
  });
  return {
    update, home,
    dispose() {
      renderer.setAnimationLoop(null);
      resize.disconnect();
      scene.traverse(object => {
        if (object instanceof THREE.Mesh || object instanceof THREE.Points) {
          object.geometry.dispose();
          const materials = Array.isArray(object.material) ? object.material : [object.material];
          materials.forEach(material => material.dispose());
        }
      });
      renderer.dispose();
      host.replaceChildren();
    },
  };
}
