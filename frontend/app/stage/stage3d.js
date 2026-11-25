import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'

/**
 * 桌面舞台（扔到桌面上那只）专用的 3D 渲染入口。
 *
 * 背景：Harbor 窗口里用的是 React + three.js 的 3D 助手，
 * 而"扔出去"的桌面舞台（electron/desktop-stage.html）原本还在用 16 帧 2D 精灵图，
 * 于是同一个角色在两处的精细度差一个数量级。
 * 本文件把 3D 渲染打包成独立 IIFE（dist/desktop-stage.js），由舞台页面直接调用，
 * 与窗口内共用同一份 assets/yalu3d/yalu.glb。
 *
 * 对外只暴露一个全局：window.HarborStage3D.mount(canvas) → { set(state), dispose() }
 */

const MODEL_URL = './assets/yalu3d/yalu.glb'
const STAGE_HEIGHT = 2.0
const FOV = 34

function fitToStage(obj, targetHeight) {
  const box = new THREE.Box3().setFromObject(obj)
  const size = new THREE.Vector3()
  const center = new THREE.Vector3()
  box.getSize(size)
  box.getCenter(center)
  const k = targetHeight / (size.y || 1)
  obj.scale.multiplyScalar(k)
  obj.position.x -= center.x * k
  obj.position.z -= center.z * k
  obj.position.y -= box.min.y * k
}

function mount(canvas) {
  if (!canvas) return null
  let renderer
  try {
    renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: 'high-performance' })
  } catch {
    return null // 无 WebGL：交给页面回退到 2D 精灵
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 1.05
  renderer.setClearColor(0x000000, 0)

  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 100)
  scene.add(new THREE.HemisphereLight(0xfff2e2, 0x2a2f3a, 1.15))
  const key = new THREE.DirectionalLight(0xffffff, 2.0)
  key.position.set(2.4, 3.6, 2.8)
  scene.add(key)
  const rim = new THREE.DirectionalLight(0x9fc7ff, 1.1)
  rim.position.set(-2.6, 2.0, -2.4)
  scene.add(rim)

  const root = new THREE.Group()
  scene.add(root)

  const state = { moving: false, facing: -1, tilt: 0, ready: false }
  let t0 = 0
  let raf = 0
  let disposed = false

  const resize = () => {
    const w = canvas.clientWidth || 264
    const h = canvas.clientHeight || 384
    if (canvas.width !== Math.round(w * renderer.getPixelRatio()) || canvas.height !== Math.round(h * renderer.getPixelRatio())) {
      renderer.setSize(w, h, false)
    }
    camera.aspect = w / Math.max(1, h)
    // 距离按 FOV 反算并留白，确保头顶脚底都不裁（与窗口内渲染同一套算法）
    const halfFov = (camera.fov * Math.PI) / 180 / 2
    const needH = (STAGE_HEIGHT * 0.5) / Math.tan(halfFov)
    const needW = (STAGE_HEIGHT * 0.42) / Math.tan(halfFov) / Math.max(0.35, camera.aspect)
    const d = Math.max(needH, needW) * 1.16
    camera.position.set(Math.sin(0.35) * Math.cos(0.12) * d, STAGE_HEIGHT * 0.52 + Math.sin(0.12) * d, Math.cos(0.35) * Math.cos(0.12) * d)
    camera.lookAt(0, STAGE_HEIGHT * 0.5, 0)
    camera.updateProjectionMatrix()
  }

  const loader = new GLTFLoader()
  loader.load(MODEL_URL, (g) => {
    if (disposed) return
    const obj = g.scene
    obj.traverse((o) => {
      if (!o.isMesh) return
      const mats = Array.isArray(o.material) ? o.material : [o.material]
      for (const m of mats) {
        if (!m) continue
        if (m.map) m.map.colorSpace = THREE.SRGBColorSpace
        // 与窗口内保持同一套材质归一，避免"里面干净、扔出去又是水渍"
        m.side = THREE.FrontSide
        if (!Number.isFinite(m.metalness) || m.metalness > 0.2) m.metalness = 0.06
        if (!Number.isFinite(m.roughness) || m.roughness > 0.9) m.roughness = 0.82
        if (m.normalMap) m.normalScale.setScalar(0.55)
      }
    })
    fitToStage(obj, STAGE_HEIGHT)
    root.add(obj)
    state.ready = true
    canvas.dataset.stage3d = 'ready'
  }, undefined, () => { canvas.dataset.stage3d = 'failed' })

  // 动作状态（带阻尼，避免瞬变产生"机械感"）
  const anim = { yaw: 0, lean: 0, squash: 0 }
  const lerp = (a, b, k) => a + (b - a) * k
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))

  const loop = (now) => {
    raf = requestAnimationFrame(loop)
    if (!t0) t0 = now
    const t = (now - t0) / 1000
    resize()

    const speed = Math.hypot(state.vx || 0, state.vy || 0)
    const moving = state.moving || speed > 12

    // ① 朝向：朝实际速度方向转身（3/4 侧身），而不是固定左右翻转
    const targetYaw = clamp((state.vx || 0) / 420, -1, 1) * 1.05 + (state.facing > 0 ? -0.16 : 0.16)
    anim.yaw = lerp(anim.yaw, targetYaw, 0.14)
    root.rotation.y = anim.yaw

    // ② 前倾：速度越大越前倾；停下自然回正
    const targetLean = clamp(speed * 0.00022, 0, 0.12) + (state.moving ? 0.03 : 0.0)
    anim.lean = lerp(anim.lean, targetLean, 0.10)
    root.rotation.x = anim.lean

    // ③ 步频随速度变化（原来固定 2.3，快慢都一样 ⇒ 机械）
    const stride = moving ? clamp(1.7 + speed / 240, 1.7, 3.6) : 0.9
    const phase = t * stride * Math.PI * 2

    // ④ 上下起伏：走两步一个周期；再加一点点左右重心转移
    const bobAmp = moving ? 0.042 : 0.016
    root.position.y = Math.abs(Math.sin(phase)) * bobAmp - (moving ? 0.008 : 0)

    // ⑤ 落地压缩 + 侧摆（squash & stretch：竖缩横胀，反作用在侧倾上）
    const targetSquash = Math.sin(phase * 2) * (moving ? 0.020 : 0.008)
    anim.squash = lerp(anim.squash, targetSquash, 0.25)
    root.scale.set(1 + anim.squash * 0.5, 1 - anim.squash, 1 + anim.squash * 0.5)

    const sideSway = Math.sin(phase) * (moving ? 0.045 : 0.012)
    root.rotation.z = sideSway - clamp((state.vx || 0) * 0.00030, -0.22, 0.22) + (state.tilt || 0) * 0.5

    renderer.render(scene, camera)
  }
  raf = requestAnimationFrame(loop)

  return {
    set(next) {
      if (!next) return
      if (typeof next.moving === 'boolean') state.moving = next.moving
      if (typeof next.facing === 'number') state.facing = next.facing
      if (typeof next.tilt === 'number') state.tilt = next.tilt
    },
    get ready() { return state.ready },
    dispose() {
      disposed = true
      cancelAnimationFrame(raf)
      renderer.dispose()
    },
  }
}

// 用自定义元素对外暴露（铁律 LAW-02 禁止挂 window 业务全局）：
// 舞台页面 document.createElement('harbor-stage-3d') 即可，状态通过 el.state 传入。
class HarborStage3DElement extends HTMLElement {
  connectedCallback() {
    if (this._handle) return
    const canvas = document.createElement('canvas')
    canvas.style.width = '100%'
    canvas.style.height = '100%'
    canvas.style.display = 'block'
    this.appendChild(canvas)
    this._handle = mount(canvas)
    this._canvas = canvas
  }
  set state(next) {
    if (this._handle) this._handle.set(next)
  }
  get ready() { return !!(this._handle && this._handle.ready) }
  disconnectedCallback() {
    if (this._handle) { this._handle.dispose(); this._handle = null }
  }
}
if (!customElements.get('harbor-stage-3d')) customElements.define('harbor-stage-3d', HarborStage3DElement)
