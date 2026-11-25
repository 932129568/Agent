import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'

/**
 * 芽露 3D 舞台（WebGL 真三维）
 *
 * 设计背景：
 *  - 用户提供的 4 个 GLB 是**静态网格**（0 骨骼 / 0 动画），已减面到 ~3.3 万面、贴图 1024，
 *    合计 14MB（原 232MB）。因此"动作生动"只能靠**程序化驱动**：
 *    根节点位移/旋转/缩放 + 道具（露芽杖、酒红铃铛）独立摆动。
 *  - 一旦交付方补上骨骼与动画片段（animations.length > 0），本组件的
 *    `useClipIfAvailable()` 会自动改用骨骼动画，程序化动效自动退为辅助层。
 *
 * 坐标系约定：GLB 统一按"包围盒最低点贴地、中心对齐原点"归一化，
 * 再整体缩放到 STAGE_HEIGHT 个单位高度，保证不同来源的模型不会大小/高低不一。
 */

const ASSETS = {
  yalu: './assets/yalu3d/yalu.glb',
  staff: './assets/yalu3d/staff.glb',
  bell: './assets/yalu3d/bell.glb',
}

const STAGE_HEIGHT = 2.0          // 归一化后人物高度（世界单位）
const PROP_LAYOUT = {
  // 道具锚点按人物高度的比例给出，避免依赖模型原始尺寸
  staff: { side: 0.42, up: 0.52, z: -0.12, rotZ: -0.35, rotX: 0.18, scale: 0.62 },
  bell: { side: -0.30, up: 0.78, z: 0.10, scale: 0.16 },
}

/** 动作配方：无骨骼时用这些参数制造"生动"的差异 */
const ACTION_RECIPES = {
  idle:        { bob: 0.030, freq: 1.15, sway: 0.030, lean: 0.02, spin: 0.00, propSwing: 0.10, breath: 0.012 },
  walk:        { bob: 0.055, freq: 2.30, sway: 0.075, lean: 0.05, spin: 0.00, propSwing: 0.20, breath: 0.010 },
  run:         { bob: 0.085, freq: 3.40, sway: 0.110, lean: 0.10, spin: 0.00, propSwing: 0.32, breath: 0.012 },
  sit_edge:    { bob: 0.022, freq: 0.85, sway: 0.045, lean: -0.06, spin: 0.00, propSwing: 0.14, breath: 0.014, drop: 0.28 },
  stretch:     { bob: 0.045, freq: 0.70, sway: 0.020, lean: -0.03, spin: 0.00, propSwing: 0.06, breath: 0.045 },
  bell_play:   { bob: 0.035, freq: 1.60, sway: 0.055, lean: 0.03, spin: 0.04, propSwing: 0.55, breath: 0.010 },
  supervising: { bob: 0.020, freq: 0.90, sway: 0.018, lean: 0.04, spin: 0.00, propSwing: 0.22, breath: 0.008 },
  magic_blackhole: { bob: 0.040, freq: 2.10, sway: 0.030, lean: 0.06, spin: 0.28, propSwing: 0.60, breath: 0.010 },
  grabbed:     { bob: 0.070, freq: 3.60, sway: 0.140, lean: 0.12, spin: 0.00, propSwing: 0.40, breath: 0.006 },
  sleep:       { bob: 0.018, freq: 0.55, sway: 0.015, lean: 0.08, spin: 0.00, propSwing: 0.05, breath: 0.022 },
  guarding:    { bob: 0.020, freq: 0.95, sway: 0.020, lean: 0.04, spin: 0.00, propSwing: 0.20, breath: 0.008 },
}

const VIEW_CAMERA = {
  auto:  { azimuth: 0.35, elevation: 0.14, distance: 3.05 },
  front: { azimuth: 0.00, elevation: 0.10, distance: 3.00 },
  side:  { azimuth: 1.55, elevation: 0.10, distance: 3.00 },
  back:  { azimuth: 3.14, elevation: 0.10, distance: 3.00 },
}

function fitObject(obj, targetHeight) {
  const box = new THREE.Box3().setFromObject(obj)
  const size = new THREE.Vector3()
  const center = new THREE.Vector3()
  box.getSize(size)
  box.getCenter(center)
  const h = size.y || 1
  const k = targetHeight / h
  obj.scale.multiplyScalar(k)
  // 归一化：x/z 居中、最低点贴地
  obj.position.x -= center.x * k
  obj.position.z -= center.z * k
  obj.position.y -= box.min.y * k
  return { size: size.clone().multiplyScalar(k), height: targetHeight }
}

function prepareMaterials(root) {
  root.traverse((o) => {
    if (!o.isMesh) return
    o.castShadow = false
    o.receiveShadow = false
    o.frustumCulled = true
    const mats = Array.isArray(o.material) ? o.material : [o.material]
    for (const m of mats) {
      if (!m) continue
      if (m.map) m.map.colorSpace = THREE.SRGBColorSpace
      if (m.emissiveMap) m.emissiveMap.colorSpace = THREE.SRGBColorSpace
      m.side = THREE.FrontSide
      m.envMapIntensity = 0.55
      m.needsUpdate = true
    }
  })
}

export default function YaluModel3D({
  actionState = 'idle',
  facing = -1,
  viewAngle = 'auto',
  lookX = 0,
  lookY = 0,
  dragTilt = 0,
  width = 136,
  height = 186,
  scale = 1,
  onReady = null,
}) {
  const hostRef = useRef(null)
  const canvasRef = useRef(null)
  const stateRef = useRef({ actionState, facing, viewAngle, lookX, lookY, dragTilt, scale })
  stateRef.current = { actionState, facing, viewAngle, lookX, lookY, dragTilt, scale }

  useEffect(() => {
    const host = hostRef.current
    if (!host) return undefined

    // 铁律 LAW-01 禁止在 React 层用 .appendChild：canvas 由 JSX 提供，three 只接管渲染上下文
    const canvasEl = canvasRef.current
    if (!canvasEl) return undefined
    let renderer
    try {
      renderer = new THREE.WebGLRenderer({
        canvas: canvasEl,
        alpha: true,
        antialias: true,
        powerPreference: 'high-performance',
      })
    } catch {
      return undefined // 无 WebGL：交给上层回退到 2D 精灵
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    renderer.outputColorSpace = THREE.SRGBColorSpace
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.toneMappingExposure = 1.05
    renderer.setClearColor(0x000000, 0)
    // e2e 断言 `[data-yalu-stage="yalu_3d"] canvas.yms-canvas` 恰好 1 个 ⇒ 类名在 JSX 上声明

    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(34, 1, 0.1, 100)

    // 三点布光：环境底 + 主光 + 冷色轮廓光（让玻璃/金属材质有体积）
    const hemi = new THREE.HemisphereLight(0xfff2e2, 0x2a2f3a, 1.15)
    scene.add(hemi)
    const key = new THREE.DirectionalLight(0xffffff, 2.0)
    key.position.set(2.4, 3.6, 2.8)
    scene.add(key)
    const rim = new THREE.DirectionalLight(0x9fc7ff, 1.1)
    rim.position.set(-2.6, 2.0, -2.4)
    scene.add(rim)

    const root = new THREE.Group()          // 人物根（程序化动效作用于此）
    const propStaff = new THREE.Group()     // 杖的摆动枢轴
    const propBell = new THREE.Group()      // 铃的垂摆枢轴
    root.add(propStaff, propBell)
    scene.add(root)

    const loader = new GLTFLoader()
    let disposed = false
    const mixers = []

    const load = (url) => new Promise((resolve) => {
      loader.load(url, (g) => resolve(g), undefined, () => resolve(null))
    })

    Promise.all([load(ASSETS.yalu), load(ASSETS.staff), load(ASSETS.bell)]).then(([gYalu, gStaff, gBell]) => {
      if (disposed) return
      if (!gYalu) { host.dataset.stage3d = 'failed'; return }

      const char = gYalu.scene
      prepareMaterials(char)
      const fit = fitObject(char, STAGE_HEIGHT)
      root.add(char)

      // 若模型自带骨骼动画（交付方后续补），优先用它们
      if (gYalu.animations && gYalu.animations.length) {
        const mixer = new THREE.AnimationMixer(char)
        const clip = gYalu.animations[0]
        mixer.clipAction(clip).play()
        mixers.push(mixer)
        host.dataset.clip = clip.name || 'clip0'
      }

      if (gStaff) {
        const s = gStaff.scene
        prepareMaterials(s)
        fitObject(s, STAGE_HEIGHT * PROP_LAYOUT.staff.scale)
        propStaff.add(s)
        propStaff.position.set(PROP_LAYOUT.staff.side, STAGE_HEIGHT * PROP_LAYOUT.staff.up, PROP_LAYOUT.staff.z)
        propStaff.rotation.set(PROP_LAYOUT.staff.rotX, 0, PROP_LAYOUT.staff.rotZ)
      }
      if (gBell) {
        const b = gBell.scene
        prepareMaterials(b)
        fitObject(b, STAGE_HEIGHT * PROP_LAYOUT.bell.scale)
        propBell.add(b)
        propBell.position.set(PROP_LAYOUT.bell.side, STAGE_HEIGHT * PROP_LAYOUT.bell.up, PROP_LAYOUT.bell.z)
      }

      host.dataset.stage3d = 'ready'
      host.dataset.modelHeight = String(fit.height)
      if (onReady) onReady({ hasClip: mixers.length > 0 })
      start()
    })

    const resize = () => {
      const w = host.clientWidth || width
      const h = host.clientHeight || height
      renderer.setSize(w, h, false)
      camera.aspect = w / Math.max(1, h)
      camera.updateProjectionMatrix()
    }
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(resize) : null
    if (ro) ro.observe(host)
    resize()

    let raf = 0
    let t0 = 0
    const tmp = new THREE.Vector3()

    const start = () => {
      if (raf) return
      raf = requestAnimationFrame(function frame(now) {
        raf = requestAnimationFrame(frame)
        if (!t0) t0 = now
        const t = (now - t0) / 1000
        const st = stateRef.current
        const rc = ACTION_RECIPES[st.actionState] || ACTION_RECIPES.idle

        // 根节点：呼吸/踏步/摆动/倾身
        const bob = Math.sin(t * rc.freq * Math.PI * 2) * rc.bob
        const breathe = 1 + Math.sin(t * rc.freq * Math.PI) * rc.breath
        root.position.y = bob - (rc.drop || 0) * STAGE_HEIGHT * 0.5
        root.rotation.z = Math.sin(t * rc.freq * Math.PI * 0.5) * rc.sway + st.dragTilt * 0.5
        root.rotation.x = rc.lean + st.dragTilt * 0.25
        root.rotation.y = rc.spin ? Math.sin(t * 0.9) * rc.spin : (st.facing < 0 ? 0.22 : -0.22)
        root.scale.set(1, breathe, 1)

        // 道具：杖随呼吸轻摆（施法时大幅），铃按阻尼垂摆
        propStaff.rotation.z = PROP_LAYOUT.staff.rotZ + Math.sin(t * rc.freq * Math.PI * 1.1) * rc.propSwing
        propStaff.rotation.x = PROP_LAYOUT.staff.rotX + Math.cos(t * rc.freq * Math.PI * 0.8) * rc.propSwing * 0.5
        propBell.rotation.z = Math.sin(t * 2.6) * rc.propSwing * 0.9
        propBell.rotation.x = Math.cos(t * 2.1) * rc.propSwing * 0.5

        // 相机：按视角预设环绕，并跟随视线轻微偏移
        const cam = VIEW_CAMERA[st.viewAngle] || VIEW_CAMERA.auto
        const az = cam.azimuth + st.lookX * 0.18
        const el = cam.elevation + st.lookY * 0.10
        const d = cam.distance / Math.max(0.6, st.scale)
        tmp.set(
          Math.sin(az) * Math.cos(el) * d,
          STAGE_HEIGHT * 0.52 + Math.sin(el) * d,
          Math.cos(az) * Math.cos(el) * d,
        )
        camera.position.copy(tmp)
        camera.lookAt(0, STAGE_HEIGHT * 0.5, 0)

        for (const m of mixers) m.update(0.016)
        renderer.render(scene, camera)
      })
    }

    return () => {
      disposed = true
      if (raf) cancelAnimationFrame(raf)
      if (ro) ro.disconnect()
      for (const m of mixers) m.stopAllAction()
      scene.traverse((o) => {
        if (o.isMesh) {
          o.geometry && o.geometry.dispose && o.geometry.dispose()
          const mats = Array.isArray(o.material) ? o.material : [o.material]
          for (const mm of mats) { if (mm && mm.dispose) mm.dispose() }
        }
      })
      renderer.dispose && renderer.dispose()
    }
  }, [])

  return (
    <div
      ref={hostRef}
      data-yalu-3d="true"
      style={{ width: '100%', height: '100%', display: 'block', position: 'relative' }}
      aria-label="芽露三维舞台"
    >
      <canvas ref={canvasRef} className="yms-canvas" style={{ width: '100%', height: '100%', display: 'block' }} aria-hidden="true" />
    </div>
  )
}
