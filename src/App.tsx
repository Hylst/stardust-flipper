import { useEffect, useRef, useState, useMemo } from 'react';
import Matter from 'matter-js';

const TABLE_W = 460;
const TABLE_H = 740;
const BALL_RADIUS = 11.5;

// ===== PLUNGER LANE : geometry is defined ONCE and used by BOTH physics and rendering =====
// Tube runs from bottom (TABLE_H) to top (y = 60), with an opening on the upper-left
// that allows the ball to exit into the playfield.
const PLUNGER_X_RIGHT = TABLE_W - 8;          // inner edge of outer wall
const PLUNGER_X_LEFT  = PLUNGER_X_RIGHT - 42; // inner edge of inner wall (separates from playfield)
const PLUNGER_W       = PLUNGER_X_RIGHT - PLUNGER_X_LEFT; // 42px wide
const PLUNGER_X_MID   = (PLUNGER_X_LEFT + PLUNGER_X_RIGHT) / 2;

const PLUNGER_TOP     = 62;   // y where the inner wall stops → ball exits
const PLUNGER_SPRING_Y = TABLE_H - 42;   // center of spring plate rectangle
const PLUNGER_BALL_SPAWN_Y = PLUNGER_SPRING_Y - 5 - BALL_RADIUS; // sits on top face of spring
const PLUNGER_EXIT_X = 385;
const PLUNGER_EXIT_Y = 110;

// Physics scaling
const GRAVITY = 0.95;
const PLUNGER_MIN_LAUNCH = 38;
const PLUNGER_MAX_LAUNCH = 56;

type BumperData = { id: string; x: number; y: number; base: number; flash: number; hits: number };
type LightLane = { id: 'l'|'c'|'r'; x: number; lit: boolean; flash: number };
type Particle = { x:number; y:number; vx:number; vy:number; life:number; max:number; col:string; size:number };
type FloatScore = { x:number; y:number; vy:number; life:number; value:string; col:string };

const bumpersSeed: Omit<BumperData, 'flash'|'hits'>[] = [
  { id: 'b1', x: 230, y: 267, base: 500 },
  { id: 'b2', x: 165, y: 340, base: 500 },
  { id: 'b3', x: 295, y: 340, base: 500 },
];

function formatScore(n: number) { return n.toString().padStart(8, '0'); }

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const gameWrapRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<Matter.Engine|null>(null);
  const runnerRef = useRef<Matter.Runner|null>(null);
  const worldRef = useRef<Matter.World|null>(null);
  const ballsRef = useRef<Matter.Body[]>([]);
  const leftFlipperRef = useRef<Matter.Body|null>(null);
  const rightFlipperRef = useRef<Matter.Body|null>(null);
  const plungerBallRef = useRef<Matter.Body|null>(null);
  const springBodyRef = useRef<Matter.Body|null>(null);

  // Game controls state (shared between keyboard / mouse / touch)
  const keysRef = useRef({ left:false, right:false, plunger:false });
  const plungerChargeRef = useRef(0);

  const bumpersRef = useRef<BumperData[]>(bumpersSeed.map(b => ({...b, flash:0, hits:0})));
  const lanesRef = useRef<LightLane[]>([
    { id:'l', x: 156, lit:false, flash:0 },
    { id:'c', x: 230, lit:false, flash:0 },
    { id:'r', x: 304, lit:false, flash:0 },
  ]);

  const particlesRef = useRef<Particle[]>([]);
  const floatScoresRef = useRef<FloatScore[]>([]);
  const shakeRef = useRef(0);
  const flashTableRef = useRef(0);

  // Game state
  const [score, setScore] = useState(0);
  const [highScore, setHighScore] = useState(() => Number(localStorage.getItem('pin87_hs') ?? 0) || 0);
  const [ballsLeft, setBallsLeft] = useState(3);
  const [ballInPlay, setBallInPlay] = useState(0);
  const [multiplier, setMultiplier] = useState(1);
  const [multiball, setMultiball] = useState(false);
  const [multiballTime, setMultiballTime] = useState(0);
  const [jackpotCount, setJackpotCount] = useState(0);
  const [gameOver, setGameOver] = useState(false);
  const [started, setStarted] = useState(false);
  const [lastMessage, setLastMessage] = useState('APPUYEZ SUR DÉPART • ESPACE');

  // Mutable mirrors for game loop
  const scoreRef = useRef(0);
  const multiplierRef = useRef(1);
  const multiballRef = useRef(false);

  useEffect(() => { scoreRef.current = score; }, [score]);
  useEffect(() => { multiplierRef.current = multiplier; }, [multiplier]);
  useEffect(() => { multiballRef.current = multiball; }, [multiball]);

  // Audio
  const audioCtxRef = useRef<AudioContext|null>(null);
  const getAudio = () => {
    if (!audioCtxRef.current) {
      try { audioCtxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)(); } catch {}
    }
    return audioCtxRef.current;
  };
  const beep = (freq: number, t=0.09, type: OscillatorType='square', vol=0.17, glideTo?:number) => {
    const ac = getAudio(); if(!ac) return;
    const o = ac.createOscillator();
    const g = ac.createGain();
    o.type = type;
    o.frequency.value = freq;
    if (glideTo) o.frequency.exponentialRampToValueAtTime(glideTo, ac.currentTime + t);
    g.gain.value = vol;
    g.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + t);
    o.connect(g); g.connect(ac.destination);
    o.start(); o.stop(ac.currentTime + t);
  };

  const addScore = (pts:number, x?:number, y?:number, col='#ffe27a') => {
    const total = Math.round(pts * multiplierRef.current * (multiballRef.current ? 1.85 : 1));
    scoreRef.current += total;
    setScore(scoreRef.current);
    if (x && y) {
      floatScoresRef.current.push({ x, y, vy:-0.9, life:66, value: `+${total.toLocaleString()}`, col });
    }
  };

  const spawnParticles = (x:number,y:number,col:string,count=14) => {
    const arr = particlesRef.current;
    for(let i=0;i<count;i++){
      const a = Math.random()*Math.PI*2;
      const sp = 1.6 + Math.random()*3.6;
      arr.push({ x,y, vx: Math.cos(a)*sp, vy: Math.sin(a)*sp, life: 28 + Math.random()*24, max: 36, col, size: 1.6 + Math.random()*2.1 });
    }
    if(arr.length > 560) arr.splice(0, arr.length-560);
  };

  // ======= PHYSICS WORLD =======
  useEffect(() => {
    const engine = Matter.Engine.create();
    engineRef.current = engine;
    engine.gravity.y = GRAVITY;
    engine.timing.timeScale = 1.0;
    const world = engine.world;
    worldRef.current = world;

    const wallOpts = { isStatic: true, restitution: 0.30, friction: 0.04, render:{visible:false} };

    const railLeft = Matter.Bodies.rectangle(16, TABLE_H/2, 30, TABLE_H, { ...wallOpts, label:'rail' });
    // Le mur droit du plateau est porte par plungerRightWall : railRight
    // debordait dans la rampe et bloquait chaque lancement.
    const topBand = Matter.Bodies.rectangle(TABLE_W/2, 34, 330, 28, { ...wallOpts, chamfer:{radius:10} });
    const topLeftCurve = Matter.Bodies.circle(93, 88, 54, { ...wallOpts });
    // Courbe superieure droite, gardee a gauche de la rampe. Les vrais
    // bloqueurs etaient railRight et orbitR, tous deux retires de la rampe.
    const topRightCurve = Matter.Bodies.circle(TABLE_W-122, 92, 34, { ...wallOpts });

    // === PLUNGER LANE TUBE ===
    // A clean vertical tube. Nothing physical is placed in the ball path.
    // A sensor at the top converts vertical launch speed into a controlled
    // entry into the playfield, like a real metal shooter lane feed.

    const plungerRightWall = Matter.Bodies.rectangle(
      PLUNGER_X_RIGHT, TABLE_H / 2, 14, TABLE_H,
      { ...wallOpts, label: 'plungerRightWall' }
    );

    const innerWallH = TABLE_H - PLUNGER_TOP;
    const innerWallCy = PLUNGER_TOP + innerWallH / 2;
    const plungerLeftWall = Matter.Bodies.rectangle(
      PLUNGER_X_LEFT, innerWallCy, 8, innerWallH,
      { ...wallOpts, label: 'plungerLeftWall' }
    );

    const plungerExit = Matter.Bodies.rectangle(
      PLUNGER_X_MID, PLUNGER_TOP - 18, PLUNGER_W - 4, 24,
      { isStatic: true, isSensor: true, label: 'plungerExit' }
    );

    // Spring plate at the bottom of the lane — the ball rests here before launch
    const plungerSpringPlate = Matter.Bodies.rectangle(
      PLUNGER_X_MID, PLUNGER_SPRING_Y, PLUNGER_W - 6, 10,
      { isStatic: true, restitution: 0.0, friction: 0.6, label: 'plungerSpring' }
    );
    springBodyRef.current = plungerSpringPlate;

    // Guides sloping to flippers — repositioned to stay clear of the plunger tube on the right
    // rightGuide ends at x ≈ 402 (tube starts at x = PLUNGER_X_LEFT = 410)
    const leftGuide = Matter.Bodies.rectangle(112, 548, 120, 18, { isStatic:true, angle: -0.55, friction:0.035, restitution:0.26, label:'guide'});
    const rightGuide = Matter.Bodies.rectangle(TABLE_W - 112, 548, 120, 18, { isStatic:true, angle: 0.55, friction:0.035, restitution:0.26, label:'guide'});

    // Outlane posts (far from flippers)
    const outLeftPost  = Matter.Bodies.circle(64, 604, 8, { isStatic:true, restitution:0.7, label:'post' });
    const outRightPost = Matter.Bodies.circle(TABLE_W - 76, 604, 8, { isStatic:true, restitution:0.7, label:'post' });
    // Inlane posts (near flippers) — also clear of plunger tube
    const inLeftPost  = Matter.Bodies.circle(130, 602, 7, { isStatic:true, restitution:0.63, label:'post' });
    const inRightPost = Matter.Bodies.circle(TABLE_W - 138, 602, 7, { isStatic:true, restitution:0.63, label:'post' });

    // Slingshots — triangular above flippers, kept away from plunger tube
    const slingL = Matter.Bodies.fromVertices(100, 550, [[
      {x:-48,y: 26},{x:48,y:26},{x:10,y:-30},{x:-10,y:-30}
    ]], { isStatic:true, restitution:1.31, friction:0.03, label:'sling' }, true);
    const slingR = Matter.Bodies.fromVertices(TABLE_W - 130, 550, [[
      {x:-48,y: 26},{x:48,y:26},{x:10,y:-30},{x:-10,y:-30}
    ]], { isStatic:true, restitution:1.31, friction:0.03, label:'sling' }, true);

    const laneY = 159;
    const laneSensors = lanesRef.current.map(l => Matter.Bodies.rectangle(l.x, laneY, 38, 15, { isStatic:true, isSensor:true, label:`lane_${l.id}` }));

    const dropTargets: Matter.Body[] = [];
    for(let i=0;i<3;i++){
      const t = Matter.Bodies.rectangle(61, 255 + i*46, 18, 28, { isStatic:true, restitution:0.7, label:`drop_${i}` });
      (t as any).dropHit = 0;
      dropTargets.push(t);
    }

    const bumperBodies = bumpersRef.current.map(b => {
      const body = Matter.Bodies.circle(b.x, b.y, 28, { isStatic:true, restitution:1.48, friction:0, label:`bumper_${b.id}`});
      (body as any).bumperId = b.id;
      return body;
    });

    const orbitL = Matter.Bodies.rectangle(47, 200, 14, 86, { isStatic:true, angle:-0.13, restitution:0.4, label:'orbit' });
    const orbitR = Matter.Bodies.rectangle(TABLE_W-92, 200, 14, 86, { isStatic:true, angle:0.13, restitution:0.4, label:'orbit' });

    const drain = Matter.Bodies.rectangle(TABLE_W/2, TABLE_H+28, 310, 50, { isStatic:true, isSensor:true, label:'drain' });

    // === FLIPPERS (improved) ===
    const flipperOpts = { density:1.15, friction:0.11, restitution:0.30, collisionFilter:{group:-1} };
    const leftFlipper = Matter.Bodies.trapezoid(170, 642, 114, 22, 0.42, { ...flipperOpts, label:'flipperL', chamfer:{radius:7} });
    const leftPivot = { x: 135, y: 642 };
    Matter.Body.setCentre(leftFlipper, { x: -34, y: 0 }, true);
    Matter.Body.setPosition(leftFlipper, leftPivot);
    const leftConstraint = Matter.Constraint.create({ bodyA: leftFlipper, pointB: leftPivot, length:0, stiffness:1 });

    const rightFlipper = Matter.Bodies.trapezoid(TABLE_W-170, 642, 114, 22, 0.42, { ...flipperOpts, label:'flipperR', chamfer:{radius:7} });
    const rightPivot = { x: TABLE_W-135, y: 642 };
    Matter.Body.setCentre(rightFlipper, { x: 34, y: 0 }, true);
    Matter.Body.setPosition(rightFlipper, rightPivot);
    const rightConstraint = Matter.Constraint.create({ bodyA: rightFlipper, pointB: rightPivot, length:0, stiffness:1 });

    leftFlipperRef.current = leftFlipper;
    rightFlipperRef.current = rightFlipper;

    Matter.World.add(world, [
      railLeft, topBand, topLeftCurve, topRightCurve,
      plungerRightWall, plungerLeftWall, plungerExit, plungerSpringPlate,
      leftGuide, rightGuide,
      outLeftPost, outRightPost, inLeftPost, inRightPost,
      slingL, slingR,
      orbitL, orbitR,
      ...laneSensors,
      ...dropTargets,
      ...bumperBodies,
      drain,
      leftFlipper, leftConstraint,
      rightFlipper, rightConstraint,
    ]);

    // Collision handling
    const handleBumper = (bumperId:string, ball:Matter.Body) => {
      const b = bumpersRef.current.find(q=>q.id===bumperId); if(!b) return;
      b.flash = 20;
      b.hits++;
      const base = multiballRef.current ? 1850 : b.base;
      addScore(base, b.x, b.y-34);
      spawnParticles(b.x, b.y, '#ffe37a', 13);
      shakeRef.current = Math.min(shakeRef.current + 1.9, 7.5);
      flashTableRef.current = 4;
      beep(670 + Math.random()*120, 0.087, 'square', 0.13);
      beep(1020, 0.055, 'triangle', 0.07);

      const dx = ball.position.x - b.x;
      const dy = ball.position.y - b.y;
      const len = Math.max(0.001, Math.hypot(dx,dy));
      const kick = 0.058 + Math.random()*0.018;
      Matter.Body.setVelocity(ball, {
        x: ball.velocity.x + (dx/len)*kick*16,
        y: ball.velocity.y + (dy/len)*kick*16
      });

      const totalHits = bumpersRef.current.reduce((s,q)=>s+q.hits,0);
      setJackpotCount(totalHits);
      if (!multiballRef.current && totalHits >= 22 && totalHits - 1 < 22) {
        setTimeout(() => startMultiball(), 340);
      }
    };

    const handleLane = (laneId:'l'|'c'|'r') => {
      const lane = lanesRef.current.find(l=>l.id===laneId);
      if(!lane || lane.lit) return;
      lane.lit = true; lane.flash = 27;
      addScore(950, lane.x, laneY+28, '#7fefff');
      beep(540 + (laneId==='l'?0:laneId==='c'?140:260), 0.125, 'sawtooth', 0.105);
      spawnParticles(lane.x, laneY, '#7ef5ff', 10);

      const allLit = lanesRef.current.every(l=>l.lit);
      if (allLit) {
        lanesRef.current.forEach(l=>{ l.lit=false; l.flash=16; });
        setMultiplier(m => {
          const next = Math.min(6, m+1);
          multiplierRef.current = next;
          return next;
        });
        addScore(7400, TABLE_W/2, 210, '#ff7adf');
        spawnParticles(TABLE_W/2, 200, '#ffa9ee', 34);
        setLastMessage('MULTIPLICATEUR +1 !');
        beep(480,0.12,'square',0.17); setTimeout(()=>beep(660,0.12,'square',0.15),90); setTimeout(()=>beep(900,0.2,'square',0.15),175);
        shakeRef.current = 6.5;
      }
    };

    Matter.Events.on(engine, 'collisionStart', (e) => {
      for(const pair of e.pairs) {
        const ballBody = pair.bodyA.label.startsWith('ball') ? pair.bodyA : pair.bodyB.label.startsWith('ball') ? pair.bodyB : null;
        if(!ballBody) continue;
        const other = ballBody === pair.bodyA ? pair.bodyB : pair.bodyA;
        const ol = other.label;

        if (ol === 'plungerExit') {
          // The shooter lane is deliberately clear: this sensor feeds the ball
          // into the upper-right playfield with a reliable, readable trajectory.
          Matter.Body.setPosition(ballBody, { x: PLUNGER_EXIT_X, y: PLUNGER_EXIT_Y });
          Matter.Body.setVelocity(ballBody, { x: -9.5, y: 2.1 });
          Matter.Body.setAngularVelocity(ballBody, -0.22);
          setLastMessage('LANCEMENT RÉUSSI • BILLE SUR LE PLATEAU');
          spawnParticles(PLUNGER_X_LEFT - 4, PLUNGER_TOP + 4, '#7fefff', 12);
          beep(760, 0.08, 'triangle', 0.11);
        } else if (ol.startsWith('bumper_')) {
          handleBumper((other as any).bumperId, ballBody);
        } else if (ol.startsWith('lane_')) {
          handleLane(ol.split('_')[1] as any);
        } else if (ol === 'sling') {
          addScore(160, other.position.x, other.position.y-18, '#ffb56b');
          spawnParticles(other.position.x, other.position.y, '#ffc88c', 7);
          beep(310,0.05,'square',0.1);
        } else if (ol.startsWith('drop_')) {
          const dh = ((other as any).dropHit || 0) + 1;
          (other as any).dropHit = dh;
          if (dh === 1) {
            other.collisionFilter.mask = 0;
            setTimeout(()=>{ other.collisionFilter.mask = 0xFFFFFFFF; (other as any).dropHit = 0; }, 4800);
          }
          addScore(780, other.position.x+24, other.position.y, '#b2ff88');
          spawnParticles(other.position.x, other.position.y, '#cfffad', 11);
          beep(755,0.08,'triangle',0.125);
          const downs = dropTargets.filter(t => ((t as any).dropHit||0) > 0).length;
          if (downs === 3) {
            dropTargets.forEach(t=>{ (t as any).dropHit = 0; t.collisionFilter.mask = 0xFFFFFFFF; });
            setMultiplier(m=>{ const n = Math.min(6, m+1); multiplierRef.current=n; return n;});
            addScore(5200, 90, 295, '#7bffd9');
            setLastMessage('BANQUE DE CIBLES TERMINÉE !');
          }
        } else if (ol === 'orbit') {
          addScore(1280, other.position.x, other.position.y, '#aabfff');
          beep(840,0.065,'sawtooth',0.105);
        } else if (ol === 'post') {
          beep(210 + Math.random()*60, 0.035, 'square', 0.073);
        }
      }
    });

    // Ball speed clamp + flipper control
    Matter.Events.on(engine, 'beforeUpdate', () => {
      for(const ball of ballsRef.current) {
        const v = ball.velocity;
        const speed = Math.hypot(v.x, v.y);
        // Robust shooter-lane feed: even if the fast launch skips the sensor
        // in one physics tick, a top-of-tube position check releases it cleanly.
        if (ball.position.x > PLUNGER_X_LEFT && ball.position.y < PLUNGER_TOP + 8 && v.y < -4) {
          Matter.Body.setPosition(ball, { x: PLUNGER_EXIT_X, y: PLUNGER_EXIT_Y });
          Matter.Body.setVelocity(ball, { x: -9.5, y: 2.1 });
          Matter.Body.setAngularVelocity(ball, -0.22);
          setLastMessage('LANCEMENT RÉUSSI • BILLE SUR LE PLATEAU');
          continue;
        }
        // Shooter lane needs high velocity to reach the top. A low global clamp
        // was silently killing launches, so only cap truly extreme speeds.
        if (speed > 64) {
          Matter.Body.setVelocity(ball, { x: v.x * 64 / speed, y: v.y * 64 / speed });
        }
        if (speed < 0.9 && ball.position.y < 320) {
          Matter.Body.applyForce(ball, ball.position, { x: (Math.random()-0.5)*0.0012, y: 0.0016 });
        }
      }
      const L = leftFlipperRef.current, R = rightFlipperRef.current;
      if (L && R) {
        const leftUp = keysRef.current.left;
        const rightUp = keysRef.current.right;
        const leftTarget = leftUp ? -0.56 : 0.50;
        const rightTarget = rightUp ? 0.56 : -0.50;
        const lDiff = leftTarget - L.angle;
        Matter.Body.setAngularVelocity(L, L.angularVelocity * 0.58 + lDiff * 0.55);
        const rDiff = rightTarget - R.angle;
        Matter.Body.setAngularVelocity(R, R.angularVelocity * 0.58 + rDiff * 0.55);
        if (!leftUp && L.angle > 0.52) { Matter.Body.setAngle(L, 0.50); Matter.Body.setAngularVelocity(L, 0); }
        if (leftUp && L.angle < -0.58) { Matter.Body.setAngle(L, -0.56); Matter.Body.setAngularVelocity(L, 0); }
        if (!rightUp && R.angle < -0.52) { Matter.Body.setAngle(R, -0.50); Matter.Body.setAngularVelocity(R, 0); }
        if (rightUp && R.angle > 0.58) { Matter.Body.setAngle(R, 0.56); Matter.Body.setAngularVelocity(R, 0); }
      }
    });

    const runner = Matter.Runner.create();
    runnerRef.current = runner;
    Matter.Runner.run(runner, engine);

    return () => {
      Matter.Runner.stop(runner);
      Matter.World.clear(world, false);
      Matter.Engine.clear(engine);
    };
  }, []);

  // ======= SPAWN / LAUNCH =======
  const spawnBall = (inPlungerLane=false) => {
    const world = worldRef.current; if(!world) return null;
    const x = inPlungerLane ? PLUNGER_X_MID : 230 + (Math.random()-0.5)*18;
    // Place sitting exactly on top of the spring plate with zero velocity
    const y = inPlungerLane ? PLUNGER_BALL_SPAWN_Y : 132;
    const ball = Matter.Bodies.circle(x, y, BALL_RADIUS, {
      restitution: 0.31,
      friction: 0.03,
      frictionAir: 0.0015,
      density: 0.0025,
      label: `ball_${Date.now()}_${Math.random()}`,
    });
    Matter.Body.setVelocity(ball, { x: 0, y: 0 });
    Matter.Body.setAngularVelocity(ball, 0);
    Matter.World.add(world, ball);
    ballsRef.current.push(ball);
    if (inPlungerLane) {
      plungerBallRef.current = ball;
    }
    setBallInPlay(b => b+1);
    return ball;
  };

  const launchPlunger = (power:number) => {
    let b = plungerBallRef.current;
    if (!b) {
      b = ballsRef.current.find(ball => ball.position.x > PLUNGER_X_LEFT && ball.position.y > PLUNGER_TOP + 40) ?? null;
      if (b) plungerBallRef.current = b;
    }
    if (!b) return;
    // Determine launch speed: full power gets MAX, weak tap still reaches top
    const vy = PLUNGER_MIN_LAUNCH + power * (PLUNGER_MAX_LAUNCH - PLUNGER_MIN_LAUNCH);
    // Lift ball 4px off spring BEFORE setting velocity to avoid collision damping
    Matter.Body.setPosition(b, { x: b.position.x, y: b.position.y - 6 });
    Matter.Body.setVelocity(b, { x: -0.3, y: -vy });
    Matter.Body.setAngularVelocity(b, 0);
    plungerBallRef.current = null;
    beep(200, 0.22, 'sawtooth', 0.18, 620);
    setLastMessage('BILLE EN JEU !');
  };

  const startMultiball = () => {
    if (multiballRef.current) return;
    multiballRef.current = true;
    setMultiball(true);
    setMultiballTime(22);
    setLastMessage('★ MULTIBOULE ★');
    setTimeout(()=>spawnBall(false), 90);
    setTimeout(()=>spawnBall(false), 380);
    bumpersRef.current.forEach(b=>b.hits=0);
    setJackpotCount(0);
    spawnParticles(230, 300, '#ffd9ff', 52);
    shakeRef.current = 12;
    beep(440,0.22,'square',0.21);
    setTimeout(()=>beep(660,0.2,'square',0.19),140);
    setTimeout(()=>beep(880,0.33,'square',0.19),278);
  };

  const drainBall = (ball:Matter.Body) => {
    const world = worldRef.current; if(!world) return;
    if (plungerBallRef.current === ball) { plungerBallRef.current = null; }
    Matter.World.remove(world, ball);
    ballsRef.current = ballsRef.current.filter(b=>b!==ball);
    setBallInPlay(c=>Math.max(0, c-1));
    spawnParticles(ball.position.x, TABLE_H-38, '#ff8c7a', 16);
    beep(240,0.24,'sawtooth',0.13, 110);
    if (ballsRef.current.length === 0) {
      setMultiplier(m=>{
        const next = Math.max(1, m-1);
        multiplierRef.current = next;
        return next;
      });
      setBallsLeft(bl => {
        const next = bl - 1;
        if (next <= 0) {
          setGameOver(true);
          setLastMessage('PARTIE TERMINÉE • APPUYEZ SUR N');
          setHighScore(h => {
            const sc = scoreRef.current;
            if (sc > h) { localStorage.setItem('pin87_hs', String(sc)); return sc;}
            return h;
          });
        } else {
          setLastMessage('BILLE PERDUE • ESPACE POUR LANCER');
          setTimeout(()=> { spawnBall(true); }, 650);
        }
        return next;
      });
      if (multiballRef.current) {
        multiballRef.current = false;
        setMultiball(false);
        setMultiballTime(0);
      }
    }
  };

  // Drain watcher
  useEffect(() => {
    const id = setInterval(() => {
      const balls = ballsRef.current.slice();
      for (const b of balls) {
        if (b.position.y > TABLE_H + 18) {
          drainBall(b);
          continue;
        }
      }
    }, 80);
    return ()=>clearInterval(id);
  }, []);

  // Multiball timer
  useEffect(() => {
    if (!multiball) return;
    const id = setInterval(()=> {
      setMultiballTime(t => {
        if (t <= 1) {
          multiballRef.current = false;
          setMultiball(false);
          setLastMessage('FIN DU MULTIBOULE');
          return 0;
        }
        return t-1;
      });
    }, 1000);
    return ()=>clearInterval(id);
  }, [multiball]);

  // ======= INPUT: KEYBOARD + MOUSE + TOUCH =======
  useEffect(() => {
    const startPlunger = () => {
      if (!keysRef.current.plunger) { getAudio(); }
      keysRef.current.plunger = true;
    };
    const releasePlunger = () => {
      if (keysRef.current.plunger) {
        const pwr = plungerChargeRef.current;
        plungerChargeRef.current = 0;
        keysRef.current.plunger = false;
        launchPlunger(Math.max(0.3, pwr));
      } else {
        keysRef.current.plunger = false;
      }
    };

    const down = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      if (['arrowleft', 'a', 'z', 'q'].includes(k)) {
        keysRef.current.left = true;
        if(!e.repeat) beep(520,0.035,'square',0.073);
      }
      if (['arrowright', 'd'].includes(k)) {
        keysRef.current.right = true;
        if(!e.repeat) beep(570,0.035,'square',0.073);
      }
      if ([' ', 'arrowdown', 'enter'].includes(k)) {
        startPlunger();
        e.preventDefault();
      }
      if (k === 'n' && gameOver) {
        ballsRef.current.forEach(b=> worldRef.current && Matter.World.remove(worldRef.current, b));
        ballsRef.current = [];
        scoreRef.current = 0; setScore(0);
        setMultiplier(1); multiplierRef.current = 1;
        setBallsLeft(3); setBallInPlay(0);
        setMultiball(false); multiballRef.current=false;
        bumpersRef.current.forEach(b=>{b.hits=0; b.flash=0});
        lanesRef.current.forEach(l=>{l.lit=false; l.flash=0});
        setJackpotCount(0);
        setGameOver(false);
        setStarted(true);
        setLastMessage('NOUVELLE PARTIE • LANCEMENT');
        setTimeout(()=>spawnBall(true), 220);
      }
      // Also: Space on start screen -> start game
      if (k === ' ' && !started) {
        startGame();
      }
    };
    const up = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      if (['arrowleft', 'a', 'z', 'q'].includes(k)) keysRef.current.left = false;
      if (['arrowright', 'd'].includes(k)) keysRef.current.right = false;
      if ([' ', 'arrowdown', 'enter'].includes(k)) {
        releasePlunger();
        e.preventDefault();
      }
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return ()=>{ window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); };
  }, [gameOver, started]);

  // ======= CANVAS RENDER =======
  useEffect(() => {
    const canvas = canvasRef.current; if (!canvas) return;
    const ctx = canvas.getContext('2d'); if(!ctx) return;
    let raf = 0;
    let lastT = performance.now();

    const render = (t:number) => {
      const dt = Math.min(33, t-lastT); lastT = t;
      const W = TABLE_W, H = TABLE_H;
      ctx.setTransform(1,0,0,1,0,0);
      ctx.clearRect(0,0,W,H);

      const shake = shakeRef.current;
      if (shake > 0.1) {
        ctx.translate((Math.random()-0.5)*shake, (Math.random()-0.5)*shake);
        shakeRef.current *= 0.88;
      }

      const ft = flashTableRef.current; if(ft>0) flashTableRef.current -= 1;
      ctx.fillStyle = ft > 0 ? '#1c2343' : '#0f1324';
      ctx.fillRect(0,0,W,H);

      ctx.save();
      ctx.globalAlpha = 0.33;
      ctx.strokeStyle = '#1c2750';
      ctx.lineWidth = 1;
      for(let y=104; y<H-120; y+=46){
        ctx.beginPath(); ctx.moveTo(35, y); ctx.lineTo(W-56, y); ctx.stroke();
      }
      ctx.restore();

      ctx.strokeStyle = '#d6d9e6';
      ctx.lineWidth = 3;
      ctx.strokeRect(2.5,2.5,W-5,H-5);
      ctx.strokeStyle = 'rgba(255,255,255,0.5)';
      ctx.lineWidth = 1.2;
      ctx.strokeRect(8,8,W-16,H-16);

      // ===== PLUNGER LANE RENDERING (tube visual) =====
      // Background of the tube (full height)
      ctx.fillStyle = 'rgba(14,20,38,0.92)';
      ctx.fillRect(PLUNGER_X_LEFT, 0, PLUNGER_W, H);

      // Outer wall (right side) — full height
      ctx.fillStyle = '#1a2240';
      ctx.fillRect(PLUNGER_X_RIGHT - 4, 0, 8, H);
      ctx.strokeStyle = 'rgba(255,255,255,0.28)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(PLUNGER_X_RIGHT - 3.5, 0);
      ctx.lineTo(PLUNGER_X_RIGHT - 3.5, H);
      ctx.stroke();

      // Inner wall (left side) — from PLUNGER_TOP to bottom
      ctx.fillStyle = '#1a2240';
      ctx.fillRect(PLUNGER_X_LEFT - 4, PLUNGER_TOP, 8, H - PLUNGER_TOP);
      ctx.strokeStyle = 'rgba(255,255,255,0.28)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(PLUNGER_X_LEFT - 3.5, PLUNGER_TOP);
      ctx.lineTo(PLUNGER_X_LEFT - 3.5, H);
      ctx.stroke();

      // Opening indicator (upper part of the lane, where the ball will exit)
      ctx.fillStyle = 'rgba(82, 226, 255, 0.08)';
      ctx.fillRect(PLUNGER_X_LEFT - 4, 0, 6, PLUNGER_TOP);
      ctx.strokeStyle = 'rgba(82, 226, 255, 0.35)';
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 4]);
      ctx.beginPath();
      ctx.moveTo(PLUNGER_X_LEFT - 3, 4);
      ctx.lineTo(PLUNGER_X_LEFT - 3, PLUNGER_TOP);
      ctx.stroke();
      ctx.setLineDash([]);

      // Clear launch mouth: visual ramp only, no physical obstacle in the tube.
      ctx.strokeStyle = 'rgba(82,226,255,0.42)';
      ctx.lineWidth = 4;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(PLUNGER_X_LEFT + 3, PLUNGER_TOP - 2);
      ctx.bezierCurveTo(410, 70, 395, 95, PLUNGER_EXIT_X, PLUNGER_EXIT_Y);
      ctx.stroke();
      ctx.lineCap = 'butt';
      ctx.fillStyle = 'rgba(126,245,255,0.7)';
      ctx.font = '700 9px "Fragment Mono", monospace';
      ctx.textAlign = 'center';
      ctx.fillText('SORTIE', PLUNGER_X_LEFT - 16, PLUNGER_TOP + 12);

      // Lane markings (inside tube)
      ctx.strokeStyle = 'rgba(255,255,255,0.06)';
      ctx.lineWidth = 1;
      for (let i = 0; i < 12; i++) {
        const my = H - 70 - i * 48;
        if (my < PLUNGER_TOP + 20) break;
        ctx.beginPath();
        ctx.moveTo(PLUNGER_X_LEFT + 6, my);
        ctx.lineTo(PLUNGER_X_RIGHT - 6, my);
        ctx.stroke();
      }

      // Spring plate at bottom (where ball sits)
      const springW = PLUNGER_W - 6;
      ctx.fillStyle = '#c9a55a';
      ctx.fillRect(PLUNGER_X_MID - springW / 2, PLUNGER_SPRING_Y - 5, springW, 10);
      ctx.fillStyle = '#e8c87a';
      ctx.fillRect(PLUNGER_X_MID - springW / 2 + 2, PLUNGER_SPRING_Y - 4, springW - 4, 4);
      // Spring coils below the plate
      ctx.strokeStyle = '#8b6f3a';
      ctx.lineWidth = 2;
      for (let i = 0; i < 6; i++) {
        const sy = PLUNGER_SPRING_Y + 8 + i * 5;
        ctx.beginPath();
        ctx.moveTo(PLUNGER_X_MID - 16, sy);
        ctx.lineTo(PLUNGER_X_MID + 16, sy);
        ctx.stroke();
      }

      // Direction arrow in lane (up)
      ctx.fillStyle = 'rgba(255,255,255,0.10)';
      ctx.font = '700 16px "Fragment Mono", monospace';
      ctx.textAlign = 'center';
      ctx.fillText('↑', PLUNGER_X_MID, H / 2 + 40);

      // Rollover lanes
      const laneY = 159;
      lanesRef.current.forEach(l => {
        const lit = l.lit;
        if (l.flash > 0) l.flash--;
        const cx = l.x, cy = laneY;
        ctx.save();
        ctx.shadowColor = lit ? '#50e8ff' : 'transparent';
        ctx.shadowBlur = lit ? 22 : 0;
        ctx.fillStyle = lit ? '#b8fbff' : '#23304c';
        ctx.beginPath();
        (ctx as any).roundRect(cx-19, cy-10, 38, 20, 10);
        ctx.fill();
        if (lit) {
          ctx.fillStyle = '#ffffff';
          ctx.font = '700 11px "Fragment Mono", monospace';
          ctx.textAlign='center';
          ctx.fillText(l.id.toUpperCase(), cx, cy+4);
        }
        ctx.restore();
      });

      ctx.strokeStyle = 'rgba(128,200,255,0.29)';
      ctx.lineWidth = 3.4;
      ctx.beginPath(); ctx.arc(61, 175, 34, 1.8, 3.9); ctx.stroke();
      ctx.beginPath(); ctx.arc(W-61, 175, 34, 5.5, 7.6); ctx.stroke();

      // Bumpers
      bumpersRef.current.forEach(b => {
        if (b.flash > 0) b.flash--;
        const power = b.flash/20;
        const r = 28 + power*4.2;
        ctx.save();
        ctx.translate(b.x, b.y);
        ctx.shadowColor = power > 0 ? '#ffd45e' : '#ff9130';
        ctx.shadowBlur = 22 + power*28;
        ctx.fillStyle = '#141b36';
        ctx.beginPath(); ctx.arc(0,0,r+4,0,Math.PI*2); ctx.fill();
        const grad = ctx.createRadialGradient(-6,-7,4,0,0,r);
        grad.addColorStop(0, power>0 ? '#fff8d7' : '#ffe09a');
        grad.addColorStop(0.45, power>0 ? '#ffcf62' : '#ff9a44');
        grad.addColorStop(1, '#cf4d1b');
        ctx.fillStyle = grad;
        ctx.beginPath(); ctx.arc(0,0,r,0,Math.PI*2); ctx.fill();
        ctx.fillStyle = power > 0 ? 'rgba(255,255,255,0.95)' : 'rgba(255,255,255,0.53)';
        ctx.beginPath(); ctx.arc(-5,-6,9.4,0,Math.PI*2); ctx.fill();
        ctx.strokeStyle = power > 0 ? '#fff5ca' : '#ffcf7a';
        ctx.lineWidth = 2.3;
        ctx.beginPath(); ctx.arc(0,0,r-5,0,Math.PI*2); ctx.stroke();
        ctx.restore();
        ctx.fillStyle = 'rgba(255,232,175,0.86)';
        ctx.font = '700 11px "Fragment Mono", monospace';
        ctx.textAlign='center';
        ctx.fillText(String(b.base), b.x, b.y + 52);
      });

      // Slingshots
      const drawSling = (cx:number, cy:number, flip:number) => {
        ctx.save();
        ctx.translate(cx,cy);
        ctx.scale(flip,1);
        ctx.fillStyle = '#192344';
        ctx.strokeStyle = '#ffd166';
        ctx.lineWidth = 2.2;
        ctx.beginPath();
        ctx.moveTo(-49, 26); ctx.lineTo(49,26); ctx.lineTo(11,-26); ctx.lineTo(-11,-26); ctx.closePath();
        ctx.fill(); ctx.stroke();
        ctx.fillStyle = 'rgba(255,209,102,0.15)';
        ctx.fill();
        ctx.restore();
      };
      drawSling(100, 550, 1);
      drawSling(W - 130, 550, -1);

      // Guides sloping to flippers (visible rails)
      const drawGuide = (cx:number, cy:number, angle:number) => {
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(angle);
        ctx.fillStyle = '#1a2240';
        ctx.strokeStyle = '#3a4565';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.roundRect(-60, -9, 120, 18, 6);
        ctx.fill();
        ctx.stroke();
        ctx.restore();
      };
      drawGuide(112, 548, -0.55);
      drawGuide(W - 112, 548, 0.55);

      // Kickback rubber arc (left side) — bounces ball back towards flippers
      ctx.strokeStyle = 'rgba(100, 180, 255, 0.45)';
      ctx.lineWidth = 6;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.arc(34, 200, 38, 1.6, 3.2);
      ctx.stroke();

      // Kickback rubber arc (right side)
      ctx.beginPath();
      ctx.arc(W - 92, 200, 38, Math.PI - 3.2, Math.PI - 1.6);
      ctx.stroke();
      ctx.lineCap = 'butt';

      const posts = [
        [64, 604], [W - 76, 604],
        [130, 602], [W - 138, 602]
      ];
      posts.forEach(([x,y])=>{
        ctx.fillStyle = '#e6ecff';
        ctx.beginPath(); ctx.arc(x,y,6.4,0,Math.PI*2); ctx.fill();
        ctx.fillStyle = '#ffbe6b';
        ctx.beginPath(); ctx.arc(x,y,2.6,0,Math.PI*2); ctx.fill();
      });

      // Drop targets
      const world = worldRef.current;
      if (world) {
        const drops = world.bodies.filter(b=>b.label.startsWith('drop_'));
        drops.forEach((d,i)=>{
          const hit = (d as any).dropHit || 0;
          const x = d.position.x, y = d.position.y;
          ctx.save();
          ctx.translate(x,y);
          ctx.rotate(d.angle);
          ctx.fillStyle = hit ? '#253151' : '#142047';
          ctx.strokeStyle = hit ? '#3b538f' : '#ffe180';
          ctx.lineWidth = 2;
          (ctx as any).roundRect(-9,-14,18,28,5);
          ctx.fill(); ctx.stroke();
          if(!hit){
            ctx.fillStyle = '#ffe19a';
            ctx.font = '700 12px "Fragment Mono", monospace';
            ctx.textAlign='center';
            ctx.fillText(String(i+1),0,4.5);
          }
          ctx.restore();
        });
      }

      // Flippers
      const drawFlipper = (body:Matter.Body|null, left:boolean) => {
        if(!body) return;
        ctx.save();
        ctx.translate(body.position.x, body.position.y);
        ctx.rotate(body.angle);
        const w = 114, h = 22;
        ctx.shadowColor = keysRef.current[left?'left':'right'] ? '#ff67d6' : '#53d5ff';
        ctx.shadowBlur = 16;
        const grad = ctx.createLinearGradient(-w/2, -h/2, w/2, h/2);
        grad.addColorStop(0, left ? '#ff6fbb' : '#66ddff');
        grad.addColorStop(1, left ? '#ff398c' : '#1aa9dd');
        ctx.fillStyle = grad;
        ctx.beginPath();
        if (left) {
          ctx.moveTo(-w/2+6, -h/2);
          ctx.lineTo(w/2-5, -h/2+3);
          ctx.lineTo(w/2-5, h/2-3);
          ctx.lineTo(-w/2+6, h/2);
        } else {
          ctx.moveTo(w/2-6, -h/2);
          ctx.lineTo(-w/2+5, -h/2+3);
          ctx.lineTo(-w/2+5, h/2-3);
          ctx.lineTo(w/2-6, h/2);
        }
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,0.27)';
        ctx.fillRect(-w/2+12, -h/2+4, w-34, 5.5);
        ctx.restore();
        const pivotX = body.position.x + (left ? -34: 34)*Math.cos(body.angle);
        const pivotY = body.position.y + (left ? -34: 34)*Math.sin(body.angle);
        ctx.fillStyle = '#f2f5ff';
        ctx.beginPath(); ctx.arc(pivotX, pivotY, 6.2,0,Math.PI*2); ctx.fill();
      };
      drawFlipper(leftFlipperRef.current, true);
      drawFlipper(rightFlipperRef.current, false);

      // Particles
      const parts = particlesRef.current;
      for(let i=parts.length-1;i>=0;i--){
        const p = parts[i];
        p.x += p.vx; p.y += p.vy;
        p.vx *= 0.985; p.vy += 0.032;
        p.life--;
        if (p.life <= 0){ parts.splice(i,1); continue; }
        ctx.globalAlpha = p.life / p.max;
        ctx.fillStyle = p.col;
        ctx.beginPath(); ctx.arc(p.x,p.y,p.size,0,Math.PI*2); ctx.fill();
      }
      ctx.globalAlpha = 1;

      // Balls
      ballsRef.current.forEach((ball, idx) => {
        const x = ball.position.x, y = ball.position.y;
        ctx.globalAlpha = 0.13;
        ctx.fillStyle = '#74eaff';
        ctx.beginPath(); ctx.arc(x - ball.velocity.x*1.9, y - ball.velocity.y*1.9, BALL_RADIUS*0.76,0,Math.PI*2); ctx.fill();
        ctx.globalAlpha = 1;
        ctx.save();
        ctx.translate(x,y);
        ctx.shadowColor = '#55e1ff';
        ctx.shadowBlur = 15;
        const bg = ctx.createRadialGradient(-4,-5,2,0,0,BALL_RADIUS);
        bg.addColorStop(0,'#ffffff');
        bg.addColorStop(0.32,'#d8faff');
        bg.addColorStop(1,'#35bfe6');
        ctx.fillStyle = bg;
        ctx.beginPath(); ctx.arc(0,0,BALL_RADIUS,0,Math.PI*2); ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,0.78)';
        ctx.beginPath(); ctx.arc(-3.6,-4.4,3.7,0,Math.PI*2); ctx.fill();
        ctx.restore();
        if (idx === 0 && multiballRef.current) {
          ctx.strokeStyle = 'rgba(255,122,230,0.65)';
          ctx.lineWidth = 2;
          ctx.beginPath(); ctx.arc(x,y,BALL_RADIUS+3.3,0,Math.PI*2); ctx.stroke();
        }
      });

      // Float scores
      const fs = floatScoresRef.current;
      for(let i=fs.length-1;i>=0;i--){
        const f = fs[i];
        f.y += f.vy; f.vy *= 0.965; f.life--;
        if(f.life<=0){ fs.splice(i,1); continue; }
        ctx.globalAlpha = Math.min(1, f.life/30);
        ctx.fillStyle = f.col;
        ctx.font = '700 16px "Fragment Mono", monospace';
        ctx.textAlign='center';
        ctx.fillText(f.value, f.x, f.y);
      }
      ctx.globalAlpha = 1;

      // Plunger charge meter + spring compression
      if (keysRef.current.plunger && plungerBallRef.current) {
        plungerChargeRef.current = Math.min(1, plungerChargeRef.current + dt*0.00185);
        const p = plungerChargeRef.current;
        const bx = PLUNGER_X_MID, by = PLUNGER_SPRING_Y - 10;
        // Spring compression visual
        const compression = p * 22;
        ctx.strokeStyle = '#8b6f3a';
        ctx.lineWidth = 2.5;
        for(let i=0; i<6; i++) {
          const sy = by + 18 + i*4 + (i/6)*compression;
          ctx.beginPath(); ctx.moveTo(bx-14, sy); ctx.lineTo(bx+14, sy); ctx.stroke();
        }
        // Power bar
        ctx.fillStyle = 'rgba(10,16,34,0.85)';
        ctx.fillRect(bx-16, by-70, 32, 55);
        const grad = ctx.createLinearGradient(bx, by-12, bx, by-68);
        grad.addColorStop(0, '#ff4d4d');
        grad.addColorStop(0.5, '#ffd44d');
        grad.addColorStop(1, '#4dff88');
        ctx.fillStyle = grad;
        ctx.fillRect(bx-13, by-15 - 45*p, 26, 45*p);
        ctx.strokeStyle = '#fff1c7'; ctx.lineWidth = 1.4;
        ctx.strokeRect(bx-16, by-70, 32, 55);
        ctx.fillStyle = '#ffeab7';
        ctx.font = '700 9px "Fragment Mono", monospace';
        ctx.textAlign='center';
        ctx.fillText('PUISSANCE', bx, by-78);
      }

      // Top info strip
      ctx.fillStyle = 'rgba(12,17,34,0.73)';
      ctx.fillRect(34, 49, W-68-50, 33);
      ctx.fillStyle = '#9fdfff';
      ctx.font = '600 11px "Fragment Mono", monospace';
      ctx.textAlign='left';
      ctx.fillText('ORBITES STARDUST • COMPTEUR JACKPOT', 44, 70);

      raf = requestAnimationFrame(render);
    };
    raf = requestAnimationFrame(render);
    return ()=>cancelAnimationFrame(raf);
  }, []);

  const multiplierDots = useMemo(()=> Array.from({length:6}, (_,i)=> i+1), []);
  const jackpotPct = Math.min(100, Math.round((jackpotCount/22)*100));

  const startGame = () => {
    // Autorise la relance depuis l'ecran de fin de partie. Pendant une
    // partie en cours, le garde-fou evite de reinitialiser le score.
    if (started && !gameOver) return;
    setStarted(true);
    setGameOver(false);
    setScore(0); scoreRef.current=0;
    setBallsLeft(3);
    setMultiplier(1); multiplierRef.current=1;
    bumpersRef.current.forEach(b=>{b.hits=0});
    lanesRef.current.forEach(l=>{l.lit=false});
    setJackpotCount(0);
    setTimeout(()=>spawnBall(true), 160);
    setLastMessage('TIREZ LE PLONGEUR • ESPACE');
    getAudio();
  };

  // ======= UI =======
  return (
    <div className="min-h-screen bg-[#06070e] text-zinc-100 relative overflow-hidden pb-24 xl:pb-0"
      style={{ fontFamily: `"Space Grotesk", system-ui, -apple-system, Segoe UI, Roboto, sans-serif`}}
    >
      <div className="absolute inset-0 pointer-events-none">
        <div className="absolute inset-0 opacity-[0.17]" style={{
          backgroundImage: `radial-gradient(1200px 720px at 50% -12%, rgba(255,104,196,0.17), transparent 60%), radial-gradient(900px 560px at 84% 15%, rgba(45,205,255,0.11), transparent 60%), radial-gradient(1000px 680px at 10% 88%, rgba(255,186,67,0.1), transparent 60%)`
        }}/>
        <div className="absolute inset-0 opacity-[0.035]" style={{
          backgroundImage: `repeating-linear-gradient(to bottom, rgba(255,255,255,0.9) 0px, transparent 2px, transparent 3px)`
        }}/>
        <div className="absolute inset-0 opacity-[.20]" style={{
          backgroundImage: `radial-gradient(1200px 700px at 50% 52%, transparent 30%, rgba(0,0,0,0.85) 82%)`
        }}/>
      </div>

      <div className="relative w-full max-w-none mx-auto px-3 lg:px-5 py-4 lg:py-5">
        <div className="flex flex-col lg:flex-row lg:items-end lg:justify-between gap-6 mb-7">
          <div>
            <div className="text-[11px] tracking-widest text-[#ff99d7]/90 font-[600]" style={{ fontFamily:`"Fragment Mono", monospace`}}>CRÉÉ PAR GEOFFROY STREIT • AVEC IA • 2026</div>
            <h1 className="mt-1 text-[40px] sm:text-[61px] leading-[0.9] tracking-[-0.024em]"
              style={{ fontFamily:`"Syne", "Space Grotesk", sans-serif`, fontWeight: 800 }}
            >
              <span className="block sm:inline text-[#ffe9f6]" style={{ textShadow: '0 0 18px rgba(255,85,185,0.42), 0 0 44px rgba(255,90,186,0.19)'}}>FLIPPER</span>
              <span className="block sm:inline sm:ml-3 text-[#a6f3ff]" style={{ textShadow: '0 0 18px rgba(82,226,255,0.31)'}}>STARDUST</span>
            </h1>
            <div className="text-[12.5px] text-zinc-400 mt-2" style={{ fontFamily:`"Fragment Mono", monospace`}}>
              FLIPPER RÉTRO • BUMPERS À HAUTE VITESSE • JACKPOT MULTIBOULE
            </div>
          </div>
          <div className="flex flex-wrap gap-3 sm:gap-5 text-[11px]" style={{ fontFamily: `"Fragment Mono", monospace` }}>
            <div className="px-3.5 py-2 rounded-full bg-white/[0.059] border border-white/[0.12] text-zinc-300">60 HZ • PHYSIQUE MATTER.JS</div>
            <div className="px-3.5 py-2 rounded-full bg-white/[0.059] border border-white/[0.12] text-zinc-300">CABINET SHAKE</div>
            <div className="px-3.5 py-2 rounded-full bg-white/[0.059] border border-white/[0.12] text-zinc-300">FLIPPERS PHYSIQUES</div>
          </div>
        </div>

        <div className="grid grid-cols-1 xl:grid-cols-[290px_minmax(520px,1fr)_290px] gap-5 items-start">
          {/* LEFT PANEL */}
          <div className="order-2 xl:order-1">
            <div className="rounded-[26px] border border-white/[0.115] bg-zinc-950/55 backdrop-blur-xl shadow-[0_30px_90px_rgba(0,0,0,0.72)] p-5 sm:p-6">
              <div className="text-[11px] text-zinc-400 tracking-widest" style={{ fontFamily: `"Fragment Mono", monospace`}}>TABLEAU DE BORD DMD</div>

              <div className="mt-4 rounded-[18px] bg-[#0b121e] border border-cyan-400/15 shadow-inner shadow-black/60 px-4 py-4">
                <div className="text-[11px] text-cyan-200/80 tracking-widest" style={{ fontFamily:`"Fragment Mono", monospace`}}>SCORE ACTUEL</div>
                <div className="text-[34px] sm:text-[41px] tracking-widest text-[#fff0c7]" style={{ fontFamily:`"Fragment Mono", monospace`, textShadow:'0 0 14px rgba(255,197,85,0.18)'}}>
                  {formatScore(score)}
                </div>
                <div className="mt-2 flex items-center justify-between text-[11px] text-zinc-400" style={{ fontFamily:`"Fragment Mono", monospace`}}>
                  <span>RECORD {formatScore(highScore)}</span>
                  <span className={`${multiball ? 'text-[#ff8ad8] animate-pulse' : 'text-zinc-500'}`}>{multiball ? `MULTIBOULE ${multiballTime}s` : 'BILLE SIMPLE'}</span>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3 mt-4">
                <div className="rounded-2xl bg-zinc-950 border border-white/[0.09] px-3.5 py-3">
                  <div className="text-[10px] text-zinc-500 tracking-widest" style={{ fontFamily: `"Fragment Mono", monospace`}}>BILLES</div>
                  <div className="flex gap-1.5 mt-2">
                    {[1,2,3].map(n => (
                      <div key={n} className={`w-[22px] h-[22px] rounded-full border ${n<=ballsLeft ? 'bg-[#ffe082] border-amber-200 shadow-[0_0_14px_rgba(255,196,82,0.29)]' : 'bg-zinc-800 border-zinc-700'}`}></div>
                    ))}
                  </div>
                  <div className="text-[11px] text-zinc-400 mt-2" style={{ fontFamily: `"Fragment Mono", monospace`}}>EN JEU : {ballInPlay}</div>
                </div>
                <div className="rounded-2xl bg-zinc-950 border border-white/[0.09] px-3.5 py-3">
                  <div className="text-[10px] text-zinc-500 tracking-widest" style={{ fontFamily: `"Fragment Mono", monospace`}}>MULTIPLICATEUR</div>
                  <div className="text-[28px] text-[#8efaff] leading-tight" style={{ fontFamily: `"Fragment Mono", monospace`}}>{multiplier}×</div>
                  <div className="flex gap-1 mt-1">
                    {multiplierDots.map(d => (
                      <span key={d} className={`h-[6px] flex-1 rounded-full ${d <= multiplier ? 'bg-[#4deaff]' : 'bg-zinc-800'}`}></span>
                    ))}
                  </div>
                </div>
              </div>

              <div className="mt-4 rounded-2xl bg-[#0f1324] border border-[#ff8ad8]/25 px-4 py-4">
                <div className="flex items-center justify-between text-[11px] text-[#ffc5ec]" style={{ fontFamily: `"Fragment Mono", monospace`}}>
                  <span>COMPTEUR JACKPOT</span>
                  <span>{jackpotCount}/22</span>
                </div>
                <div className="h-[10px] rounded-full bg-zinc-900 mt-2 overflow-hidden border border-white/[0.08]">
                  <div className="h-full bg-gradient-to-r from-fuchsia-400 via-amber-300 to-cyan-300 transition-all" style={{ width: `${jackpotPct}%` }} />
                </div>
                <div className="text-[11px] text-zinc-400 mt-2" style={{ fontFamily: `"Fragment Mono", monospace`}}>
                  Tapez les bumpers. À 22 → MULTIBOULE
                </div>
              </div>

              <div className="mt-4 rounded-2xl bg-zinc-950/80 border border-white/[0.08] px-4 py-3 text-[12px] text-zinc-300 leading-relaxed">
                <div className="text-[10px] uppercase tracking-widest text-zinc-500 mb-2" style={{ fontFamily: `"Fragment Mono", monospace`}}>GUIDE DU PLATEAU</div>
                <ul className="space-y-1.5 text-zinc-300/90">
                  <li><b className="text-amber-200">Bumpers</b> 500 pts • gros rebond</li>
                  <li><b className="text-cyan-200">Voies de passage</b> 950 • 3 allumées = +1 multiplicateur</li>
                  <li><b className="text-emerald-200">Cibles tombantes</b> 780 • banque complète pour multiplicateur</li>
                  <li><b className="text-[#ff9dce]">Slingshots</b> 160 • chaos garanti</li>
                  <li><b className="text-[#ffd48d]">Orbites</b> 1280 pts</li>
                </ul>
              </div>

              <div className="mt-4 text-[12px] text-zinc-400 leading-relaxed" style={{ fontFamily:`"Fragment Mono", monospace`}}>
                MULTIBOULE : 3 billes, 22s, tous les points ×1.85. Gardez les flippers en vie.
              </div>
            </div>

            {/* CONTROLS */}
            <div className="mt-4 rounded-[22px] border border-white/[0.09] bg-zinc-950/40 px-5 py-4 text-[12.5px] text-zinc-300">
              <b className="text-zinc-200">Contrôles</b>
              <div className="mt-2 space-y-1.5" style={{ fontFamily: `"Fragment Mono", monospace`}}>
                <div>Flipper gauche : <span className="text-zinc-100">← / A / Z / Q</span></div>
                <div>Flipper droit : <span className="text-zinc-100">→ / D</span></div>
                <div>Plongeur / Lancer : <span className="text-zinc-100">Maintenir Espace / ↓</span></div>
                <div>Clic / Touche sur les boutons : <span className="text-zinc-100">Souris / Tactile</span></div>
                <div>Nouvelle partie : <span className="text-zinc-100">N</span></div>
              </div>

              <div className="mt-3 text-[11px] text-zinc-400" style={{ fontFamily: `"Fragment Mono", monospace`}}>
                ASTUCE : Maintenez Espace enfoncé pour charger le ressort (jaune→vert), relâchez pour lancer.
              </div>

              <div className="mt-3 hidden xl:flex flex-wrap gap-2">
                <button
                  onMouseDown={()=>{keysRef.current.left=true}}
                  onMouseUp={()=>{keysRef.current.left=false}}
                  onMouseLeave={()=>{keysRef.current.left=false}}
                  onTouchStart={(e)=>{e.preventDefault(); keysRef.current.left=true}}
                  onTouchEnd={(e)=>{e.preventDefault(); keysRef.current.left=false}}
                  onContextMenu={(e)=>e.preventDefault()}
                  className="flex-1 min-w-[122px] select-none rounded-xl bg-gradient-to-b from-[#ff6fbb] to-[#ff398c] text-white font-bold px-3 py-3 shadow-[0_4px_14px_rgba(255,57,140,0.35)] active:translate-y-[1px] active:shadow-[0_2px_6px_rgba(255,57,140,0.35)]"
                >◂ FLIPPER GAUCHE</button>
                <button
                  onMouseDown={()=>{keysRef.current.right=true}}
                  onMouseUp={()=>{keysRef.current.right=false}}
                  onMouseLeave={()=>{keysRef.current.right=false}}
                  onTouchStart={(e)=>{e.preventDefault(); keysRef.current.right=true}}
                  onTouchEnd={(e)=>{e.preventDefault(); keysRef.current.right=false}}
                  onContextMenu={(e)=>e.preventDefault()}
                  className="flex-1 min-w-[122px] select-none rounded-xl bg-gradient-to-b from-[#66ddff] to-[#1aa9dd] text-white font-bold px-3 py-3 shadow-[0_4px_14px_rgba(26,169,221,0.35)] active:translate-y-[1px] active:shadow-[0_2px_6px_rgba(26,169,221,0.35)]"
                >FLIPPER DROIT ▸</button>
              </div>

              <button
                className="hidden xl:block w-full mt-2 select-none rounded-xl bg-gradient-to-b from-amber-200 to-amber-400 text-zinc-900 font-bold px-3 py-3 shadow-[0_4px_14px_rgba(251,191,36,0.35)] active:translate-y-[1px]"
                onMouseDown={(e)=>{e.preventDefault(); keysRef.current.plunger=true; getAudio();}}
                onMouseUp={(e)=>{
                  e.preventDefault();
                  if(keysRef.current.plunger){
                    const p=plungerChargeRef.current;
                    plungerChargeRef.current=0;
                    keysRef.current.plunger=false;
                    launchPlunger(Math.max(0.3, p));
                    if(!started) startGame();
                  }
                }}
                onMouseLeave={(e)=>{
                  e.preventDefault();
                  if(keysRef.current.plunger){
                    const p=plungerChargeRef.current;
                    plungerChargeRef.current=0;
                    keysRef.current.plunger=false;
                    launchPlunger(Math.max(0.3, p));
                  }
                }}
                onTouchStart={(e)=>{e.preventDefault(); keysRef.current.plunger=true; getAudio();}}
                onTouchEnd={(e)=>{
                  e.preventDefault();
                  if(keysRef.current.plunger){
                    const p=plungerChargeRef.current;
                    plungerChargeRef.current=0;
                    keysRef.current.plunger=false;
                    launchPlunger(Math.max(0.3, p));
                    if(!started) startGame();
                  }
                }}
                onContextMenu={(e)=>e.preventDefault()}
              >
                ⤴ TIREZ / LANCEZ • RESORT
              </button>

              <div className="mt-2 text-[11px] text-zinc-400 text-center" style={{ fontFamily: `"Fragment Mono", monospace`}}>
                Clics souris, doigts ou clavier : tous les contrôles fonctionnent.
              </div>
            </div>
          </div>

          {/* CABINET */}
          <div className="order-1 xl:order-2 flex justify-center">
            <div
              ref={gameWrapRef}
              className="relative rounded-[34px] border border-zinc-700 bg-[#1a1619] shadow-[0_40px_130px_rgba(0,0,0,0.82),inset_0_1px_0_rgba(255,255,255,0.05)] p-[20px] sm:p-[28px] select-none"
              style={{ background: `linear-gradient(165deg, #353036 0%, #19151a 32%, #100d12 100%)` }}
            >
              <div className="absolute -left-[16px] top-8 bottom-8 w-[16px] rounded-l-[20px] opacity-[.88]" style={{ background: `linear-gradient(90deg, #3a231a, #7d4d2e 55%, #a86a3d)`}}/>
              <div className="absolute -right-[16px] top-8 bottom-8 w-[16px] rounded-r-[20px] opacity-[.88]" style={{ background: `linear-gradient(270deg, #3a231a, #7d4d2e 55%, #a86a3d)`}}/>

              <div className="w-[min(78vw,580px)] max-w-[88vw] rounded-[18px] bg-[#0c1020] border border-cyan-300/15 mb-[16px] px-4 py-3 flex items-center justify-between shadow-inner" style={{ boxShadow: 'inset 0 0 32px rgba(73,224,255,0.07)'}}>
                <div className="text-[11px] text-cyan-200/90 tracking-wide" style={{ fontFamily:`"Fragment Mono", monospace`}}>
                  {lastMessage}
                </div>
                <div className="flex items-center gap-2 text-[11px] text-zinc-300" style={{ fontFamily:`"Fragment Mono", monospace`}}>
                  <span className={`px-2 py-1 rounded-full border ${multiball ? 'border-fuchsia-400/60 text-fuchsia-200 bg-fuchsia-400/10' : 'border-zinc-700 text-zinc-400'}`}>{multiball ? 'MULTIBOULE' : 'SIMPLE'}</span>
                  <span className="text-zinc-400">×{multiplier}</span>
                </div>
              </div>

              <div className="relative rounded-[22px] overflow-hidden bg-[#04060d] shadow-[inset_0_0_54px_rgba(0,0,0,0.98)] ring-1 ring-white/[0.11]">
                <canvas
                  ref={canvasRef}
                  width={TABLE_W}
                  height={TABLE_H}
                  className="block w-[min(78vw,580px)] max-w-[88vw] h-auto touch-none"
                  style={{ aspectRatio: `${TABLE_W}/${TABLE_H}`}}
                />
                {!started && (
                  <div className="absolute inset-0 bg-[#070a18]/78 backdrop-blur-[2.5px] flex items-center justify-center">
                    <div className="text-center px-6">
                      <div className="text-[13px] text-cyan-200 tracking-widest" style={{ fontFamily:`"Fragment Mono", monospace`}}>INSÉREZ UNE PIÈCE</div>
                      <div className="mt-2 text-[34px] font-[800] tracking-tight text-white" style={{ fontFamily:`"Syne", sans-serif`}}>Appuyez pour jouer</div>
                      <button
                        onClick={startGame}
                        className="mt-4 rounded-full bg-[#ffe182] text-zinc-900 font-[700] px-5 py-2.5 shadow-[0_8px_30px_rgba(255,215,100,0.23)] hover:brightness-[1.04] transition"
                      >
                        COMMENCER • ESPACE
                      </button>
                      <div className="mt-3 text-[11px] text-zinc-400" style={{ fontFamily:`"Fragment Mono", monospace`}}>3 BILLES • JACKPOT MULTIBOULE • FLIPPERS PHYSIQUES</div>
                    </div>
                  </div>
                )}
                {gameOver && (
                  <div className="absolute inset-0 bg-[#060713]/80 flex items-center justify-center">
                    <div className="text-center px-6">
                      <div className="text-amber-200 text-[12px] tracking-widest" style={{ fontFamily:`"Fragment Mono", monospace`}}>PARTIE TERMINÉE</div>
                      <div className="text-white text-[40px] font-[800]" style={{ fontFamily:`"Syne", sans-serif`}}>{formatScore(score)}</div>
                      <div className="text-zinc-400 text-[12px]" style={{ fontFamily:`"Fragment Mono", monospace`}}>Record : {formatScore(highScore)}</div>
                      <button onClick={startGame} className="mt-4 rounded-full bg-white text-zinc-900 px-4 py-2 font-[700]">Rejouer • N</button>
                    </div>
                  </div>
                )}
              </div>

              <div className="mt-[14px] rounded-[16px] border border-white/[0.09] bg-[#12141e]/90 px-4 py-[11px] flex items-center justify-between text-[11px] text-zinc-300" style={{ fontFamily:`"Fragment Mono", monospace`}}>
                <span>FLIPPER STARDUST • G.STREIT 2026</span>
                <span className="text-zinc-400">CRÉDITS 0 • JEU LIBRE</span>
                <span className="text-zinc-400">TILT 0/3</span>
              </div>
            </div>
          </div>

          {/* RIGHT PANEL */}
          <div className="order-3">
            <div className="rounded-[26px] border border-white/[0.10] bg-zinc-950/55 backdrop-blur-xl shadow-[0_30px_90px_rgba(0,0,0,0.7)] p-5 sm:p-6">
              <div className="text-[11px] text-zinc-400 tracking-widest" style={{ fontFamily:`"Fragment Mono", monospace`}}>ÉTAT DES VOIES</div>
              <div className="mt-3 grid grid-cols-3 gap-2 text-center">
                {lanesRef.current.map(l => (
                  <div key={l.id} className={`rounded-xl border px-3 py-[13px] transition ${l.lit ? 'bg-cyan-400/12 border-cyan-300/40 text-cyan-100 shadow-[0_0_24px_rgba(64,230,255,0.10)]' : 'bg-zinc-950 border-zinc-800 text-zinc-500'}`}>
                    <div className="text-[10px]" style={{ fontFamily:`"Fragment Mono", monospace`}}>VOIE</div>
                    <div className="text-[20px] font-[700]">{l.id.toUpperCase()}</div>
                  </div>
                ))}
              </div>
              <div className="mt-2 text-[11.5px] text-zinc-400">Allumez les 3 voies pour +1 multiplicateur et 7 400 bonus.</div>

              <div className="h-px bg-white/[0.08] my-5" />

              <div className="text-[11px] text-zinc-400 tracking-widest" style={{ fontFamily:`"Fragment Mono", monospace`}}>BUMPERS JACKPOT</div>
              <div className="mt-3 space-y-2">
                {bumpersRef.current.map(b => (
                  <div key={b.id} className="flex items-center justify-between rounded-xl bg-zinc-950 border border-white/[0.07] px-3 py-[11px] text-[12.5px]">
                    <span className="text-zinc-300" style={{ fontFamily:`"Fragment Mono", monospace`}}>{b.id.toUpperCase()}</span>
                    <span className="text-amber-200" style={{ fontFamily:`"Fragment Mono", monospace`}}>{b.hits} coups</span>
                  </div>
                ))}
              </div>
              <div className="mt-3 text-[11.5px] text-zinc-400">
                22 coups cumulés activent le Multiboule. Les scores sont boostés pendant le Multiboule.
              </div>

              <div className="h-px bg-white/[0.08] my-5" />

              <div className="rounded-2xl bg-gradient-to-br from-[#1a1631] to-[#10182c] border border-fuchsia-400/15 p-4">
                <div className="text-[11px] tracking-widest text-fuchsia-200/90" style={{ fontFamily:`"Fragment Mono", monospace`}}>MULTIPLICATEUR DE CHAMP</div>
                <div className="mt-1 text-[30px] text-white" style={{ fontFamily:`"Fragment Mono", monospace`}}>{multiplier.toFixed(1)}×</div>
                <div className="text-[12px] text-zinc-300 mt-1">
                  Empilez les multiplicateurs via les voies et les banques de cibles. Max 6×. Décroît de 1 par bille perdue.
                </div>
              </div>

              <div className="mt-5 rounded-2xl bg-zinc-950 border border-white/[0.09] px-4 py-3 text-[12.5px] text-zinc-300">
                <div className="font-[600] text-zinc-100 mb-1">Astuces Flipper</div>
                <ul className="list-disc pl-4 space-y-1 text-zinc-400">
                  <li>Piéger la bille : maintenez le flipper en haut.</li>
                  <li>La « prise vive » adoucit les retours rapides.</li>
                  <li>Passe-postes : rebond sur les piliers intérieurs.</li>
                  <li>Petits coups secs pour les ajustements, tilt désactivé.</li>
                </ul>
              </div>
            </div>

            <div className="mt-4 rounded-[22px] border border-amber-300/18 bg-amber-300/[0.065] text-amber-100 px-4 py-4 text-[12.5px]">
              <b>Notes du créateur :</b> Flipper Stardust est un hommage aux flippers widebody de la fin des années 80 : bumpers aveuglants, slingshots agressifs, et un multiboule à 3 billes qui transforme toute la table en jackpot. Course au score, gardez le multiplicateur en vie !
              <div className="mt-2 text-[11px] text-amber-200/80" style={{ fontFamily: `"Fragment Mono", monospace`}}>Geoffroy Streit, avec IA</div>
            </div>
          </div>
        </div>

        <div className="flipper-mobile-bar">
          <button
            onPointerDown={(e)=>{e.preventDefault(); keysRef.current.left=true;}}
            onPointerUp={()=>{keysRef.current.left=false;}}
            onPointerLeave={()=>{keysRef.current.left=false;}}
            onPointerCancel={()=>{keysRef.current.left=false;}}
          >◂ GAUCHE</button>
          <button
            onPointerDown={(e)=>{e.preventDefault(); keysRef.current.plunger=true; getAudio();}}
            onPointerUp={(e)=>{e.preventDefault(); if(keysRef.current.plunger){ const p=plungerChargeRef.current; plungerChargeRef.current=0; keysRef.current.plunger=false; launchPlunger(Math.max(0.3, p)); if(!started) startGame(); }}}
            onPointerLeave={()=>{keysRef.current.plunger=false;}}
            onPointerCancel={()=>{keysRef.current.plunger=false;}}
          >⤴ LANCER</button>
          <button
            onPointerDown={(e)=>{e.preventDefault(); keysRef.current.right=true;}}
            onPointerUp={()=>{keysRef.current.right=false;}}
            onPointerLeave={()=>{keysRef.current.right=false;}}
            onPointerCancel={()=>{keysRef.current.right=false;}}
          >DROITE ▸</button>
        </div>

        <div className="mt-10 text-center text-[11px] text-zinc-500" style={{ fontFamily:`"Fragment Mono", monospace`}}>
          Construit avec Matter.js • Canvas 2D • 2026 • Casque audio pour les SFX 8-bit
        </div>
      </div>
    </div>
  );
}
