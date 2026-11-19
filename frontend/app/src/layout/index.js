/**
 * 布局区域登记表（规范 §4）：10 个区域外壳组件 + 稳定的 key 顺序。
 * 组件由 tools/gen-layout.mjs 生成；B0 批次替换为真实结构。
 */
import IconDefs from './IconDefs.jsx'
import AuroraBg from './AuroraBg.jsx'
import StreamBar from './StreamBar.jsx'
import Rail from './Rail.jsx'
import Sidebar from './Sidebar.jsx'
import SidebarBackdrop from './SidebarBackdrop.jsx'
import MainShell from './MainShell.jsx'
import ProjectModal from './ProjectModal.jsx'
import ExpertCenter from './ExpertCenter.jsx'
import HubMarket from './HubMarket.jsx'

export const LAYOUT_AREAS = [
  'icon-defs', 'aurora-bg', 'stream-bar', 'rail', 'sidebar',
  'sidebar-backdrop', 'main-shell', 'project-modal', 'expert-center', 'hub-market',
]

export const LAYOUT_COMPONENTS = [
  IconDefs, AuroraBg, StreamBar, Rail, Sidebar,
  SidebarBackdrop, MainShell, ProjectModal, ExpertCenter, HubMarket,
]

export const LAYOUT_AREA_COUNT = LAYOUT_AREAS.length

export { IconDefs, AuroraBg, StreamBar, Rail, Sidebar,
  SidebarBackdrop, MainShell, ProjectModal, ExpertCenter, HubMarket }
