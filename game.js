/* ============================================================
   DAY 100 — Floating Island Survival
   Single-tree floating island, Minecraft-style block building,
   100-day/night survival cycle.
   ============================================================ */

(function(){
'use strict';

// ---------------------------------------------------------
// CONSTANTS
// ---------------------------------------------------------
const BLOCK = 1; // world unit per block
const DAY_LENGTH_SEC = 240;      // real seconds per full day/night cycle (4 min)
const TOTAL_DAYS = 100;
const GRAVITY = -22;
const JUMP_SPEED = 8.2;
const WALK_SPEED = 5.2;
const SPRINT_SPEED = 8.4;
const PLAYER_HEIGHT = 1.7;
const PLAYER_RADIUS = 0.32;
const REACH = 6;

const BLOCK_TYPES = {
  grass:  { name:'Grass Block',  color:0x5da83a, top:0x6dbf46, icon:'\u{1FAB4}' },
  dirt:   { name:'Dirt',         color:0x8a5a34, top:0x8a5a34, icon:'\u{1F9F1}' },
  stone:  { name:'Stone',        color:0x8a8a8f, top:0x8a8a8f, icon:'\u{1FAA8}' },
  wood:   { name:'Wood Plank',   color:0xa9723c, top:0xa9723c, icon:'\u{1FAB5}' },
  leaves: { name:'Leaves',       color:0x3f7d32, top:0x3f7d32, icon:'\u{1F343}' },
  torch:  { name:'Torch',        color:0xffcf6b, top:0xffcf6b, icon:'\u{1F526}' }
};
const HOTBAR_ORDER = ['dirt','stone','wood','leaves','torch','grass'];

// ---------------------------------------------------------
// RENDERER / SCENE / CAMERA
// ---------------------------------------------------------
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(75, window.innerWidth/window.innerHeight, 0.05, 800);

const renderer = new THREE.WebGLRenderer({ antialias:true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.getElementById('canvas-wrap').appendChild(renderer.domElement);

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth/window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ---------------------------------------------------------
// SKY / FOG / LIGHTING
// ---------------------------------------------------------
scene.fog = new THREE.FogExp2(0x8fb3e8, 0.012);

const sunLight = new THREE.DirectionalLight(0xfff2d6, 1.4);
sunLight.castShadow = true;
sunLight.shadow.mapSize.set(2048,2048);
sunLight.shadow.camera.near = 1;
sunLight.shadow.camera.far = 120;
sunLight.shadow.camera.left = -40;
sunLight.shadow.camera.right = 40;
sunLight.shadow.camera.top = 40;
sunLight.shadow.camera.bottom = -40;
sunLight.shadow.bias = -0.0018;
scene.add(sunLight);
scene.add(sunLight.target);

const moonLight = new THREE.DirectionalLight(0x8fa8ff, 0.0);
scene.add(moonLight);
scene.add(moonLight.target);

const hemiLight = new THREE.HemisphereLight(0x9fc4ff, 0x3a2f22, 0.55);
scene.add(hemiLight);

const ambient = new THREE.AmbientLight(0xffffff, 0.18);
scene.add(ambient);

// Sun/moon visual sprites
function makeGlowSprite(color, size){
  const c = document.createElement('canvas'); c.width=128; c.height=128;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(64,64,0,64,64,64);
  g.addColorStop(0, color); g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g; ctx.fillRect(0,0,128,128);
  const tex = new THREE.CanvasTexture(c);
  const mat = new THREE.SpriteMaterial({ map:tex, transparent:true, depthWrite:false });
  const spr = new THREE.Sprite(mat);
  spr.scale.set(size,size,1);
  return spr;
}
const sunSprite = makeGlowSprite('rgba(255,244,214,1)', 40);
const moonSprite = makeGlowSprite('rgba(200,215,255,1)', 22);
scene.add(sunSprite, moonSprite);

// Stars
const starGeo = new THREE.BufferGeometry();
const starCount = 1200;
const starPos = new Float32Array(starCount*3);
for(let i=0;i<starCount;i++){
  const r = 300;
  const theta = Math.random()*Math.PI*2;
  const phi = Math.acos(Math.random()*0.9); // upper hemisphere-ish
  starPos[i*3] = r*Math.sin(phi)*Math.cos(theta);
  starPos[i*3+1] = Math.abs(r*Math.cos(phi))*0.9 + 20;
  starPos[i*3+2] = r*Math.sin(phi)*Math.sin(theta);
}
starGeo.setAttribute('position', new THREE.BufferAttribute(starPos,3));
const starMat = new THREE.PointsMaterial({ color:0xffffff, size:1.4, transparent:true, opacity:0 });
const stars = new THREE.Points(starGeo, starMat);
scene.add(stars);

// Clouds (simple flat billboards drifting below/around island)
const cloudGroup = new THREE.Group();
const cloudGeo = new THREE.PlaneGeometry(14, 7);
for(let i=0;i<26;i++){
  const cm = new THREE.MeshBasicMaterial({ color:0xffffff, transparent:true, opacity:0.55, depthWrite:false });
  const cloud = new THREE.Mesh(cloudGeo, cm);
  const ang = Math.random()*Math.PI*2;
  const dist = 40 + Math.random()*160;
  cloud.position.set(Math.cos(ang)*dist, -12 - Math.random()*30, Math.sin(ang)*dist);
  cloud.rotation.x = -Math.PI/2;
  cloud.userData.speed = 0.15 + Math.random()*0.3;
  cloud.userData.angle = ang;
  cloud.userData.dist = dist;
  cloudGroup.add(cloud);
}
scene.add(cloudGroup);

// ---------------------------------------------------------
// VOXEL WORLD DATA
// ---------------------------------------------------------
// key "x,y,z" -> blockType string
const world = new Map();
function key(x,y,z){ return x+','+y+','+z; }
function getBlock(x,y,z){ return world.get(key(x,y,z)) || null; }
function setBlock(x,y,z,type){ world.set(key(x,y,z), type); }
function removeBlockData(x,y,z){ world.delete(key(x,y,z)); }

// Mesh registry: key -> mesh (instanced per-block for simplicity; use merged approach)
const blockMeshes = new Map(); // key -> Mesh
const worldGroup = new THREE.Group();
scene.add(worldGroup);

// Shared geometry
const boxGeo = new THREE.BoxGeometry(BLOCK, BLOCK, BLOCK);
function materialFor(type){
  const def = BLOCK_TYPES[type];
  if(type === 'torch'){
    return new THREE.MeshStandardMaterial({ color:def.color, emissive:0xffaa33, emissiveIntensity:0.9, roughness:0.6 });
  }
  return new THREE.MeshStandardMaterial({ color:def.color, roughness:0.95, metalness:0.02 });
}
const matCache = {};
Object.keys(BLOCK_TYPES).forEach(t => matCache[t] = materialFor(t));

function addBlock(x,y,z,type, isStatic){
  if(getBlock(x,y,z)) return false;
  setBlock(x,y,z,type);
  const mesh = new THREE.Mesh(boxGeo, matCache[type]);
  mesh.position.set(x+0.5, y+0.5, z+0.5);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.userData.isStatic = !!isStatic;
  mesh.userData.blockType = type;
  worldGroup.add(mesh);
  blockMeshes.set(key(x,y,z), mesh);

  if(type === 'torch'){
    const pl = new THREE.PointLight(0xffaa44, 1.2, 9, 2);
    pl.position.set(0,0,0);
    mesh.add(pl);
  }
  return true;
}
function removeBlock(x,y,z){
  const k = key(x,y,z);
  const mesh = blockMeshes.get(k);
  if(!mesh) return null;
  if(mesh.userData.isStatic) return null; // can't break terrain core / tree
  const type = mesh.userData.blockType;
  worldGroup.remove(mesh);
  blockMeshes.delete(k);
  removeBlockData(x,y,z);
  return type;
}

// ---------------------------------------------------------
// ISLAND GENERATION
// ---------------------------------------------------------
// Build a roughly circular floating island with layered grass/dirt/stone,
// tapering to a jagged rocky underside.
const ISLAND_RADIUS = 11;
const ISLAND_CENTER = {x:0, z:0};
const TOP_Y = 0; // grass surface level

function islandHeightProfile(dx, dz){
  const d = Math.sqrt(dx*dx+dz*dz);
  return d; // distance from center, used for tapering
}

function generateIsland(){
  // simple pseudo-random for edge irregularity
  function rand(x,z,seed){
    const s = Math.sin(x*127.1 + z*311.7 + seed) * 43758.5453;
    return s - Math.floor(s);
  }

  for(let x=-ISLAND_RADIUS; x<=ISLAND_RADIUS; x++){
    for(let z=-ISLAND_RADIUS; z<=ISLAND_RADIUS; z++){
      const d = islandHeightProfile(x,z);
      const edgeNoise = (rand(x,z,1)-0.5)*2.2;
      const radius = ISLAND_RADIUS + edgeNoise*0.6;
      if(d > radius) continue;

      // depth of island varies with distance from center (dome-ish, deeper in middle)
      const falloff = 1 - (d/radius);
      const depth = Math.max(2, Math.round(3 + falloff*6 + rand(x,z,2)*2));

      for(let layer=0; layer<depth; layer++){
        const y = TOP_Y - layer;
        let type;
        if(layer === 0) type = 'grass';
        else if(layer <= 2) type = 'dirt';
        else type = 'stone';
        // taper: skip some outer/lower blocks randomly near edge & bottom for jagged underside
        if(layer > 1){
          const chance = (layer/depth);
          if(d > radius*0.7 && rand(x+layer,z-layer,3) < chance*0.5) continue;
        }
        addBlock(x,y,z,type,true);
      }
    }
  }
}
generateIsland();

// ---------------------------------------------------------
// TREE MODEL (loaded from embedded GLB)
// ---------------------------------------------------------
let treeBoundsRadius = 3; // fallback collision radius around trunk
const treeGroup = new THREE.Group();
treeGroup.position.set(ISLAND_CENTER.x, TOP_Y+1, ISLAND_CENTER.z);
scene.add(treeGroup);

function base64ToArrayBuffer(base64){
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for(let i=0;i<len;i++) bytes[i] = binaryString.charCodeAt(i);
  return bytes.buffer;
}

const loader = new THREE.GLTFLoader();
try {
  const buf = base64ToArrayBuffer(TREE_GLB_BASE64);
  loader.parse(buf, '', (gltf)=>{
    const model = gltf.scene;
    // normalize scale/position: compute bounding box
    const box = new THREE.Box3().setFromObject(model);
    const size = new THREE.Vector3(); box.getSize(size);
    const center = new THREE.Vector3(); box.getCenter(center);
    const desiredHeight = 13;
    const scale = desiredHeight / (size.y || 1);
    model.scale.setScalar(scale);

    // recompute after scaling
    const box2 = new THREE.Box3().setFromObject(model);
    const size2 = new THREE.Vector3(); box2.getSize(size2);
    const center2 = new THREE.Vector3(); box2.getCenter(center2);
    model.position.x -= center2.x;
    model.position.z -= center2.z;
    model.position.y -= box2.min.y; // sit base at y=0 of group

    model.traverse(n=>{
      if(n.isMesh){ n.castShadow = true; n.receiveShadow = true; }
    });
    treeGroup.add(model);
    treeBoundsRadius = Math.max(1.4, Math.min(size2.x, size2.z)/2 * 0.55);
    log('The old maple stands watch over your island.');
  }, (err)=>{
    console.error('GLTF parse error', err);
    fallbackTree();
  });
} catch(e){
  console.error('Tree load failed', e);
  fallbackTree();
}

function fallbackTree(){
  const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.5,0.7,6,8), new THREE.MeshStandardMaterial({color:0x6b4226}));
  trunk.position.y = 3; trunk.castShadow = true;
  const leaves = new THREE.Mesh(new THREE.SphereGeometry(3.2,10,8), new THREE.MeshStandardMaterial({color:0x3f7d32}));
  leaves.position.y = 7.5; leaves.castShadow = true;
  treeGroup.add(trunk, leaves);
}

// ---------------------------------------------------------
// UTILITY: message log
// ---------------------------------------------------------
function log(msg){
  const el = document.createElement('div');
  el.className = 'msg';
  el.textContent = msg;
  const logEl = document.getElementById('msg-log');
  logEl.appendChild(el);
  setTimeout(()=>{ el.remove(); }, 4000);
  // cap
  while(logEl.children.length > 5) logEl.removeChild(logEl.firstChild);
}

window.__game = { scene, camera, renderer, world, getBlock, addBlock, removeBlock, log, worldGroup, treeGroup, treeBoundsRadiusRef:()=>treeBoundsRadius };

// ---------------------------------------------------------
// PLAYER STATE
// ---------------------------------------------------------
const player = {
  pos: new THREE.Vector3(0, TOP_Y+1+3, 6),
  vel: new THREE.Vector3(0,0,0),
  yaw: Math.PI,
  pitch: -0.15,
  onGround: false,
  health: 100,
  hunger: 100,
  stamina: 100,
  sprinting: false,
  alive: true
};
(function findSpawn(){
  for(let y=20; y>=-15; y--){
    if(getBlock(0,y,3)){ player.pos.set(0.5, y+1+PLAYER_HEIGHT-1.0, 3.5); break; }
  }
})();

let cameraMode = 3;
const thirdPersonDist = 5.5;

// ---------------------------------------------------------
// INPUT
// ---------------------------------------------------------
const keys = {};
let pointerLocked = false;
let selectedSlot = 0;
const inventory = {};
HOTBAR_ORDER.forEach(t=> inventory[t]=0);
inventory.wood = 6;
inventory.dirt = 4;
inventory.torch = 3;
inventory.stone = 4;

function updateHotbarUI(){
  HOTBAR_ORDER.forEach((t,i)=>{
    const el = document.getElementById('cnt-'+i);
    if(el) el.textContent = inventory[t] || 0;
  });
}
updateHotbarUI();

document.querySelectorAll('.slot').forEach(slotEl=>{
  slotEl.addEventListener('click', ()=>{
    selectedSlot = parseInt(slotEl.dataset.slot,10);
    refreshHotbarActive();
  });
});
function refreshHotbarActive(){
  document.querySelectorAll('.slot').forEach(el=>{
    el.classList.toggle('active', parseInt(el.dataset.slot,10)===selectedSlot);
  });
}

window.addEventListener('keydown', (e)=>{
  keys[e.code] = true;
  if(e.code >= 'Digit1' && e.code <= 'Digit6'){
    selectedSlot = parseInt(e.code.replace('Digit',''),10)-1;
    refreshHotbarActive();
  }
  if(e.code === 'KeyF'){
    cameraMode = cameraMode === 3 ? 1 : 3;
  }
  if(e.code === 'KeyE'){
    eatFood();
  }
});
window.addEventListener('keyup', (e)=>{ keys[e.code] = false; });

const canvas = renderer.domElement;
canvas.addEventListener('click', ()=>{
  if(!pointerLocked) canvas.requestPointerLock();
});
document.addEventListener('pointerlockchange', ()=>{
  pointerLocked = document.pointerLockElement === canvas;
  document.getElementById('pointer-hint').style.display = pointerLocked ? 'none' : (window.__gameStarted ? 'flex' : 'none');
});
document.addEventListener('mousemove', (e)=>{
  if(!pointerLocked) return;
  player.yaw -= e.movementX * 0.0022;
  player.pitch -= e.movementY * 0.0022;
  player.pitch = Math.max(-Math.PI/2+0.05, Math.min(Math.PI/2-0.05, player.pitch));
});

canvas.addEventListener('mousedown', (e)=>{
  if(!pointerLocked || !window.__gameStarted || !player.alive) return;
  if(e.button === 0) breakBlockAction();
  if(e.button === 2) placeBlockAction();
});
canvas.addEventListener('contextmenu', (e)=> e.preventDefault());

// ---------------------------------------------------------
// RAYCASTING FOR BUILD/BREAK
// ---------------------------------------------------------
const raycaster = new THREE.Raycaster();
raycaster.far = REACH;

function getLookRay(){
  const dir = new THREE.Vector3(
    Math.sin(player.yaw)*Math.cos(player.pitch)*-1,
    Math.sin(player.pitch),
    Math.cos(player.yaw)*Math.cos(player.pitch)*-1
  ).normalize();
  const origin = camera.position.clone();
  raycaster.set(origin, dir);
  return raycaster;
}

function breakBlockAction(){
  const ray = getLookRay();
  const hits = ray.intersectObjects(worldGroup.children, false);
  if(hits.length === 0) return;
  const hit = hits[0];
  const mesh = hit.object;
  const x = Math.floor(mesh.position.x);
  const y = Math.floor(mesh.position.y);
  const z = Math.floor(mesh.position.z);
  if(mesh.userData.isStatic){
    log("Too solid to break — that's the island's core.");
    return;
  }
  const type = removeBlock(x,y,z);
  if(type){
    inventory[type] = (inventory[type]||0) + 1;
    updateHotbarUI();
  }
}

function placeBlockAction(){
  const ray = getLookRay();
  const hits = ray.intersectObjects(worldGroup.children, false);
  if(hits.length === 0) return;
  const hit = hits[0];
  const mesh = hit.object;
  const normal = hit.face.normal.clone();
  normal.transformDirection(mesh.matrixWorld);
  const bx = Math.floor(mesh.position.x + normal.x);
  const by = Math.floor(mesh.position.y + normal.y);
  const bz = Math.floor(mesh.position.z + normal.z);

  const type = HOTBAR_ORDER[selectedSlot];
  if((inventory[type]||0) <= 0){
    log("You don't have any " + BLOCK_TYPES[type].name.toLowerCase() + " left.");
    return;
  }
  const px = Math.floor(player.pos.x), py = Math.floor(player.pos.y), py2 = Math.floor(player.pos.y+1), pz = Math.floor(player.pos.z);
  if(bx===px && bz===pz && (by===py || by===py2)) return;

  const placed = addBlock(bx,by,bz,type,false);
  if(placed){
    inventory[type]--;
    updateHotbarUI();
  }
}

function eatFood(){
  if((inventory.leaves||0) > 0){
    inventory.leaves--;
    player.hunger = Math.min(100, player.hunger + 22);
    updateHotbarUI();
    log('You eat foraged leaves & berries. Hunger restored.');
  } else {
    log('No food to eat — gather leaves from the tree.');
  }
}

// ---------------------------------------------------------
// COLLISION
// ---------------------------------------------------------
function isSolid(x,y,z){
  const bx = Math.floor(x), by = Math.floor(y), bz = Math.floor(z);
  if(getBlock(bx,by,bz)) return true;
  const dx = x - treeGroup.position.x;
  const dz = z - treeGroup.position.z;
  const distFromTrunk = Math.sqrt(dx*dx+dz*dz);
  if(distFromTrunk < 0.9 && y < treeGroup.position.y + 10) return true;
  return false;
}

function collidesAt(pos){
  const r = PLAYER_RADIUS;
  const checks = [
    [pos.x-r,pos.y,pos.z-r],[pos.x+r,pos.y,pos.z-r],
    [pos.x-r,pos.y,pos.z+r],[pos.x+r,pos.y,pos.z+r],
    [pos.x-r,pos.y+PLAYER_HEIGHT*0.5,pos.z-r],[pos.x+r,pos.y+PLAYER_HEIGHT*0.5,pos.z+r],
    [pos.x-r,pos.y+PLAYER_HEIGHT-0.1,pos.z-r],[pos.x+r,pos.y+PLAYER_HEIGHT-0.1,pos.z+r],
  ];
  for(const [x,y,z] of checks){
    if(isSolid(x,y,z)) return true;
  }
  return false;
}

const FALL_DEATH_Y = -40;

function updatePlayerPhysics(dt){
  if(!player.alive) return;
  const speed = (player.sprinting && player.stamina > 1) ? SPRINT_SPEED : WALK_SPEED;
  const forward = new THREE.Vector3(Math.sin(player.yaw)*-1, 0, Math.cos(player.yaw)*-1);
  const right = new THREE.Vector3(forward.z*-1, 0, forward.x);

  let move = new THREE.Vector3();
  if(keys['KeyW']) move.add(forward);
  if(keys['KeyS']) move.sub(forward);
  if(keys['KeyA']) move.sub(right);
  if(keys['KeyD']) move.add(right);
  if(move.lengthSq() > 0){
    move.normalize().multiplyScalar(speed*dt);
  }

  player.sprinting = keys['ShiftLeft'] && move.lengthSq() > 0 && player.stamina > 1;
  if(player.sprinting){
    player.stamina = Math.max(0, player.stamina - 14*dt);
  } else {
    player.stamina = Math.min(100, player.stamina + 7*dt);
  }

  const nextX = player.pos.clone(); nextX.x += move.x;
  if(!collidesAt(nextX)) player.pos.x = nextX.x;
  const nextZ = player.pos.clone(); nextZ.z += move.z;
  if(!collidesAt(nextZ)) player.pos.z = nextZ.z;

  player.vel.y += GRAVITY*dt;
  if(keys['Space'] && player.onGround){
    player.vel.y = JUMP_SPEED;
    player.onGround = false;
  }
  const nextY = player.pos.clone(); nextY.y += player.vel.y*dt;
  if(collidesAt(nextY)){
    if(player.vel.y < 0){ player.onGround = true; }
    player.vel.y = 0;
  } else {
    player.pos.y = nextY.y;
    player.onGround = false;
  }
  if(!player.onGround){
    const belowCheck = player.pos.clone(); belowCheck.y -= 0.05;
    if(collidesAt(belowCheck) && player.vel.y <= 0) player.onGround = true;
  }

  if(player.pos.y < FALL_DEATH_Y){
    killPlayer('You fell from the island into the endless sky below.');
  }
}

function updateCamera(){
  const eyeHeight = PLAYER_HEIGHT - 0.15;
  const headPos = new THREE.Vector3(player.pos.x, player.pos.y+eyeHeight, player.pos.z);

  const lookDir = new THREE.Vector3(
    Math.sin(player.yaw)*Math.cos(player.pitch)*-1,
    Math.sin(player.pitch),
    Math.cos(player.yaw)*Math.cos(player.pitch)*-1
  );

  if(cameraMode === 1){
    camera.position.copy(headPos);
    camera.lookAt(headPos.clone().add(lookDir));
  } else {
    const desired = headPos.clone().sub(lookDir.clone().multiplyScalar(thirdPersonDist));
    desired.y += 1.1;
    camera.position.lerp(desired, 1);
    camera.lookAt(headPos.clone().add(lookDir.clone().multiplyScalar(3)));
  }
}

window.__player = player;
window.__inventory = inventory;

// ---------------------------------------------------------
// VISIBLE PLAYER BODY (third-person)
// ---------------------------------------------------------
const bodyGroup = new THREE.Group();
const skinMat = new THREE.MeshStandardMaterial({ color:0xe0a978, roughness:0.8 });
const shirtMat = new THREE.MeshStandardMaterial({ color:0x3d6ea5, roughness:0.9 });
const pantsMat = new THREE.MeshStandardMaterial({ color:0x2c3e50, roughness:0.9 });

const torso = new THREE.Mesh(new THREE.BoxGeometry(0.5,0.7,0.28), shirtMat);
torso.position.y = 1.05; torso.castShadow = true;
const head = new THREE.Mesh(new THREE.BoxGeometry(0.42,0.42,0.42), skinMat);
head.position.y = 1.6; head.castShadow = true;
const armL = new THREE.Mesh(new THREE.BoxGeometry(0.18,0.62,0.18), shirtMat);
armL.position.set(-0.34,1.05,0); armL.castShadow = true;
const armR = armL.clone(); armR.position.x = 0.34;
const legL = new THREE.Mesh(new THREE.BoxGeometry(0.2,0.68,0.2), pantsMat);
legL.position.set(-0.14,0.35,0); legL.castShadow = true;
const legR = legL.clone(); legR.position.x = 0.14;
bodyGroup.add(torso, head, armL, armR, legL, legR);
scene.add(bodyGroup);

function updateBody(dt, moving){
  bodyGroup.position.set(player.pos.x, player.pos.y, player.pos.z);
  bodyGroup.rotation.y = player.yaw;
  bodyGroup.visible = (cameraMode === 3);
  const t = performance.now()*0.008;
  if(moving && player.onGround){
    const swing = Math.sin(t)*0.5;
    armL.rotation.x = swing; armR.rotation.x = -swing;
    legL.rotation.x = -swing; legR.rotation.x = swing;
  } else {
    armL.rotation.x *= 0.8; armR.rotation.x *= 0.8;
    legL.rotation.x *= 0.8; legR.rotation.x *= 0.8;
  }
}

// ---------------------------------------------------------
// DAY / NIGHT CYCLE
// ---------------------------------------------------------
let elapsedSec = 0;      // total elapsed seconds since game start
let currentDay = 1;
let dayFraction = 0;     // 0..1 within current day (0=dawn start)
let isNight = false;
let gameWon = false;

function updateDayNightCycle(dt){
  if(!player.alive || gameWon) return;
  elapsedSec += dt;
  const totalDayProgress = elapsedSec / DAY_LENGTH_SEC;
  currentDay = Math.floor(totalDayProgress) + 1;
  dayFraction = totalDayProgress % 1;

  if(currentDay > TOTAL_DAYS){
    winGame();
    return;
  }

  // sun angle: 0 = sunrise, 0.5 = sunset/dusk, cycles full circle
  const angle = dayFraction * Math.PI * 2 - Math.PI/2; // start at horizon rising
  const sunDist = 90;
  const sunY = Math.sin(angle) * sunDist;
  const sunX = Math.cos(angle) * sunDist;
  sunLight.position.set(sunX, Math.max(sunY,-20), 20);
  sunLight.target.position.set(0,0,0);
  sunSprite.position.set(sunX*1.5, sunY*1.5+10, 20*1.5);

  const moonAngle = angle + Math.PI;
  const moonY = Math.sin(moonAngle)*sunDist;
  const moonX = Math.cos(moonAngle)*sunDist;
  moonLight.position.set(moonX, Math.max(moonY,-20), -20);
  moonLight.target.position.set(0,0,0);
  moonSprite.position.set(moonX*1.5, moonY*1.5+10, -20*1.5);

  // daylight factor: 1 at noon, 0 at night
  const daylight = Math.max(0, Math.sin(angle));
  const nightAmt = Math.max(0, -Math.sin(angle));
  isNight = daylight < 0.08;

  sunLight.intensity = daylight * 1.5;
  moonLight.intensity = nightAmt * 0.35;
  hemiLight.intensity = 0.15 + daylight*0.5;
  ambient.intensity = 0.06 + daylight*0.22 + nightAmt*0.05;
  sunSprite.material.opacity = daylight;
  moonSprite.material.opacity = nightAmt*0.9;
  starMat.opacity = nightAmt*0.9;

  // sky color lerp: day blue -> sunset orange -> night navy
  const dayColor = new THREE.Color(0x8fb3e8);
  const sunsetColor = new THREE.Color(0xff9a56);
  const nightColor = new THREE.Color(0x050812);
  let skyColor;
  const dawnDuskWindow = 0.12;
  const distFromHorizon = Math.abs(Math.sin(angle));
  if(daylight > 0.02){
    // blend day/sunset based on how low the sun is
    const t = 1 - Math.min(1, daylight/0.35);
    skyColor = dayColor.clone().lerp(sunsetColor, Math.max(0,t)*0.7);
  } else {
    const t = Math.min(1, nightAmt/0.35);
    skyColor = sunsetColor.clone().lerp(nightColor, t);
  }
  renderer.setClearColor(skyColor, 1);
  scene.fog.color = skyColor;

  // night overlay vignette intensifies with darkness
  document.getElementById('night-overlay').style.opacity = (nightAmt*0.85).toFixed(2);

  // update HUD clock
  const dayBadge = document.getElementById('day-badge');
  dayBadge.textContent = 'DAY ' + currentDay + ' / ' + TOTAL_DAYS + (isNight ? '  \u{1F319}' : '  \u2600\uFE0F');
  dayBadge.classList.toggle('day100', currentDay >= 100);
  document.getElementById('clock-bar').style.width = (dayFraction*100).toFixed(1)+'%';

  // clouds drift
  cloudGroup.children.forEach(c=>{
    c.userData.angle += c.userData.speed*dt*0.02;
    c.position.x = Math.cos(c.userData.angle)*c.userData.dist;
    c.position.z = Math.sin(c.userData.angle)*c.userData.dist;
  });
  stars.rotation.y += dt*0.001;
}

// ---------------------------------------------------------
// SURVIVAL TICKING (hunger drains, damages if starving, night chill etc)
// ---------------------------------------------------------
let lastDayForHungerTick = 1;
function updateSurvival(dt){
  if(!player.alive || gameWon) return;

  // hunger drains steadily
  player.hunger = Math.max(0, player.hunger - dt*(100/(DAY_LENGTH_SEC*3.4)));

  if(player.hunger <= 0){
    player.health -= dt*3.2; // starving damages health
  } else if(player.hunger > 60){
    // slow natural regen when well fed
    player.health = Math.min(100, player.health + dt*0.6);
  }

  // night is more dangerous if far from any torch light (simple ambient-based risk)
  if(isNight){
    const nearTorch = isNearTorch(player.pos, 6);
    if(!nearTorch){
      player.health -= dt*0.9; // exposure to the dark
      if(Math.random() < dt*0.15) flashDamage();
    }
  }

  if(player.health <= 0){
    killPlayer('Hunger and the dark finally caught up with you.');
  }

  updateStatBars();
}

function isNearTorch(pos, radius){
  for(const [k, mesh] of blockMeshes){
    if(mesh.userData.blockType === 'torch'){
      const d = mesh.position.distanceTo(pos);
      if(d < radius) return true;
    }
  }
  return false;
}

function updateStatBars(){
  document.getElementById('health-bar').style.width = Math.max(0,player.health)+'%';
  document.getElementById('hunger-bar').style.width = Math.max(0,player.hunger)+'%';
  document.getElementById('stamina-bar').style.width = Math.max(0,player.stamina)+'%';
}

function flashDamage(){
  const el = document.getElementById('damage-flash');
  el.style.opacity = '1';
  setTimeout(()=>{ el.style.opacity='0'; }, 150);
}

// ---------------------------------------------------------
// GATHERING FROM TREE (click leaves area for food/wood-ish resource trickle)
// ---------------------------------------------------------
// Passive: every so often near the tree, auto-forage a leaf resource when idle E press already covers eating.
// Add periodic gentle reward for staying near tree at dawn (encourages return trips).
let lastForageCheck = 0;
function updateForaging(dt){
  lastForageCheck += dt;
  if(lastForageCheck < 5) return;
  lastForageCheck = 0;
  const distToTree = Math.sqrt((player.pos.x-treeGroup.position.x)**2 + (player.pos.z-treeGroup.position.z)**2);
  if(distToTree < 5 && Math.random() < 0.5){
    inventory.leaves = (inventory.leaves||0)+1;
    updateHotbarUI();
  }
}

// ---------------------------------------------------------
// DEATH / WIN
// ---------------------------------------------------------
function killPlayer(reason){
  if(!player.alive) return;
  player.alive = false;
  document.exitPointerLock();
  const end = document.getElementById('end-screen');
  end.className = 'dead';
  document.getElementById('end-title').textContent = 'YOU DIED';
  document.getElementById('end-desc').textContent = reason + '  —  Survived ' + (currentDay-1) + ' of 100 days.';
  end.style.display = 'flex';
}

function winGame(){
  if(gameWon) return;
  gameWon = true;
  document.exitPointerLock();
  const end = document.getElementById('end-screen');
  end.className = 'win';
  document.getElementById('end-title').textContent = 'DAY 100';
  document.getElementById('end-desc').textContent = 'You survived one hundred days alone on the island, and the old maple still stands.';
  end.style.display = 'flex';
}

document.getElementById('restart-btn').addEventListener('click', ()=>{
  location.reload();
});

window.__killPlayer = killPlayer;

// ---------------------------------------------------------
// START SCREEN / MAIN LOOP
// ---------------------------------------------------------
window.__gameStarted = false;
document.getElementById('loading-note').textContent = 'ready.';

document.getElementById('start-btn').addEventListener('click', ()=>{
  document.getElementById('start-screen').style.display = 'none';
  window.__gameStarted = true;
  canvas.requestPointerLock();
  log('Day 1 begins. Survive until Day 100.');
});

let lastTime = performance.now();
function animate(){
  requestAnimationFrame(animate);
  const now = performance.now();
  let dt = (now - lastTime)/1000;
  lastTime = now;
  dt = Math.min(dt, 0.06); // clamp for tab-switch lag

  if(window.__gameStarted && player.alive && !gameWon){
    const wasMoving = keys['KeyW']||keys['KeyA']||keys['KeyS']||keys['KeyD'];
    updatePlayerPhysics(dt);
    updateBody(dt, wasMoving);
    updateDayNightCycle(dt);
    updateSurvival(dt);
    updateForaging(dt);
  }
  updateCamera();
  renderer.render(scene, camera);
}
animate();

})();
