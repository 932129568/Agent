# -*- coding: utf-8 -*-
"""Settings navigation: nested set-block ancestor activation must stay visible."""
from test_model_executor_foundation import run_case

MODULES = ['frontend/src/settings/navigation.js']
HELPERS = r'''
class FakeClassList {
  constructor() { this.items = []; }
  contains(name) { return this.items.includes(name); }
  add(...names) { names.forEach(name => { if (!this.items.includes(name)) this.items.push(name); }); }
  remove(...names) { this.items = this.items.filter(name => !names.includes(name)); }
  toggle(name, force = !this.items.includes(name)) {
    if (force) this.add(name); else this.remove(name);
    return this.items.includes(name);
  }
}
class El {
  constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.parentNode = null;
    this.classList = new FakeClassList(); this.dataset = {}; this.style = {}; this.id = '';
    this.textContent = ''; this.innerHTML = ''; this.offsetWidth = 1; }
  get className() { return this.classList.items.join(' '); }
  set className(value) { this.classList.items = String(value).split(/\s+/).filter(Boolean); }
  get parentElement() { return this.parentNode; }
  appendChild(child) { child.parentNode = this; this.children.push(child); return child; }
  replaceChildren() { this.children.forEach(child => { child.parentNode = null; }); this.children = []; }
  querySelectorAll(selector) {
    if (selector === '.set-nav-btn') return walk(this).filter(node => node.classList.contains('set-nav-btn'));
    return walk(this).filter(node => node.classList.contains(selector.slice(1)));
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}
function walk(root) { return [root, ...root.children.flatMap(walk)]; }
function textOf(root) { return root.textContent + root.children.map(textOf).join(''); }
function makeBlock(id, title, parent) {
  const block = document.createElement('section'); block.id = id; block.classList.add('set-block');
  const titleElement = document.createElement('div'); titleElement.classList.add('set-title');
  titleElement.textContent = title; block.appendChild(titleElement);
  parent.appendChild(block); return block;
}
const document = { body: new El('body'),
  createElement(tag) { const element = new El(tag); return element; },
  getElementById(id) { return walk(this.body).find(node => node.id === id) || null; },
  querySelector(selector) {
    if (selector === '#settingsPanel .set-content') return walk(this.body).find(node => node.id === 'setContent') || null;
    if (selector === '#settingsPanel .set-block') return this.querySelectorAll(selector)[0] || null;
    return null;
  },
  querySelectorAll(selector) {
    if (selector === '#settingsPanel .set-block') {
      const panel = walk(this.body).find(node => node.id === 'settingsPanel');
      return panel ? walk(panel).filter(node => node.classList.contains('set-block')) : [];
    }
    return [];
  } };
globalThis.document = document;
const settingsPanel = document.createElement('div'); settingsPanel.id = 'settingsPanel'; document.body.appendChild(settingsPanel);
const setContent = document.createElement('div'); setContent.id = 'setContent'; settingsPanel.appendChild(setContent);
const hybridBlock = makeBlock('hybridBlock', '混合路由', setContent);
const collaborationBlock = makeBlock('collaborationBlock', '双模型协同', hybridBlock);
const sandboxBlock = makeBlock('sandboxBlock', '命令沙箱', setContent);
const setNav = document.createElement('nav'); setNav.id = 'setNav'; settingsPanel.appendChild(setNav);
function activeIds() { return document.querySelectorAll('#settingsPanel .set-block')
  .filter(block => block.classList.contains('active')).map(block => block.id); }
function navButtons() { return setNav.querySelectorAll('.set-nav-btn'); }
function navOnIds() { return navButtons().filter(button => button.classList.contains('on')).map(button => button.dataset.target); }
function show(id) { const button = navButtons().find(button => button.dataset.target === id); button.onclick(); }
'''


def test_build_set_nav_includes_nested_collaboration_block():
    result = run_case(HELPERS + r'''
buildSetNav();
return {buttons: navButtons().map(button => ({target:button.dataset.target, title:button.title}))};
''', MODULES)
    buttons = result['buttons']
    collaboration = next(item for item in buttons if item['target'] == 'collaborationBlock')
    hybrid = next(item for item in buttons if item['target'] == 'hybridBlock')
    assert '双模型协同' in collaboration['title'] and '混合路由' in hybrid['title']
    assert len(buttons) == 3


def test_nested_target_activates_all_set_block_ancestors_and_only_clicked_nav():
    result = run_case(HELPERS + r'''
buildSetNav(); show('collaborationBlock');
return {active:activeIds(), navOn:navOnIds(),
  parentClass:hybridBlock.classList.contains('active'),
  childClass:collaborationBlock.classList.contains('active'),
  sandboxClass:sandboxBlock.classList.contains('active')};
''', MODULES)
    assert result['active'] == ['hybridBlock', 'collaborationBlock']
    assert result['navOn'] == ['collaborationBlock']
    assert result['parentClass'] is True and result['childClass'] is True
    assert result['sandboxClass'] is False


def test_parent_and_normal_blocks_remain_mutually_exclusive():
    result = run_case(HELPERS + r'''
buildSetNav(); show('hybridBlock');
const hybridState = {active:activeIds(), navOn:navOnIds(), child:collaborationBlock.classList.contains('active')};
show('sandboxBlock');
const sandboxState = {active:activeIds(), navOn:navOnIds(), parent:hybridBlock.classList.contains('active'),
  child:collaborationBlock.classList.contains('active')};
return {hybridState, sandboxState};
''', MODULES)
    assert result['hybridState']['active'] == ['hybridBlock']
    assert result['hybridState']['navOn'] == ['hybridBlock']
    assert result['hybridState']['child'] is False
    assert result['sandboxState']['active'] == ['sandboxBlock']
    assert result['sandboxState']['navOn'] == ['sandboxBlock']
    assert result['sandboxState']['parent'] is False and result['sandboxState']['child'] is False
