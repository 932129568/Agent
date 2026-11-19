/* ================= 会话管理 ================= */
const PROJECTS_KEY = 'glm_projects';
let projects = [];
let _taskGroupCollapsed = false;
const _collapsedProjects = new Set();
const RUN_STATUS_META = {
  working: { label: '进行中', title: '会话正在运行' },
  completed: { label: '已完成', title: '会话已完成' },
  paused: { label: '已暂停', title: '会话已暂停' },
  failed: { label: '运行失败', title: '会话运行失败' },
};
