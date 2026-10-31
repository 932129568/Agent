/* Exactly eight read-only component descriptors and safe renderers. */
const UI_COMPONENT_DESCRIPTORS = Object.create(null);
const uiText = UiSchema.z.string().max(UI_LIMITS.text);
const uiScalar = UiSchema.z.union([
  uiText, UiSchema.z.number().finite(), UiSchema.z.boolean(), UiSchema.z.null(),
]);
const uiLabelValue = UiSchema.z.object({ label: uiText, value: uiScalar }).strict();
const uiStatus = UiSchema.z.enum(['pending', 'doing', 'done', 'blocked', 'skipped']);

function registerUiComponent(name, descriptor) {
  if (!descriptor || !descriptor.schema || typeof descriptor.schema.safeParse !== 'function' ||
      typeof descriptor.renderer !== 'function' || typeof descriptor.role !== 'string' ||
      !descriptor.aria || !descriptor.keyboard ||
      typeof descriptor.keyboard.focusable !== 'boolean' ||
      !descriptor.responsive || typeof descriptor.responsive.rule !== 'string' ||
      !Object.prototype.hasOwnProperty.call(descriptor, 'bindProp')) {
    throw new Error('component_metadata_incomplete');
  }
  if (!UI_COMPONENTS.includes(name)) throw new Error('unknown_component');
  if (UI_COMPONENT_DESCRIPTORS[name]) throw new Error('duplicate_component');
  UI_COMPONENT_DESCRIPTORS[name] = Object.freeze(descriptor);
  return true;
}
function uiAria(descriptor, props) {
  return typeof descriptor.aria === 'function' ? descriptor.aria(props) : descriptor.aria;
}
function uiFallback(code, context, component) {
  context.metrics[code] = (context.metrics[code] || 0) + 1;
  const result = renderUiComponent({ component: 'EmptyState', props: {
    title: '暂时无法显示此区块',
    body: component ? '未注册组件：' + component : '组件参数未通过校验',
  } }, context);
  result.fallback = code;
  return result;
}
function renderUiComponent(block, context) {
  const descriptor = UI_COMPONENT_DESCRIPTORS[block.component];
  if (!descriptor) return uiFallback('unknown_component', context, block.component);
  const parsed = descriptor.schema.safeParse(block.props || {});
  if (!parsed.success) return uiFallback('invalid_props', context, block.component);
  const element = descriptor.renderer(parsed.data, context);
  element.setAttribute('role', descriptor.role);
  const aria = uiAria(descriptor, parsed.data);
  for (const [key, value] of Object.entries(aria)) {
    const name = key === 'label' ? 'aria-label' :
      (key === 'labelledby' ? 'aria-labelledby' : 'aria-' + key);
    element.setAttribute(name, String(value));
  }
  if (descriptor.keyboard.focusable && element.getAttribute('tabindex') === null) {
    element.setAttribute('tabindex', '0');
  }
  return { element, descriptor, props: parsed.data };
}

registerUiComponent('Table', {
  schema: UiSchema.z.object({
    columns: UiSchema.z.array(uiText).min(1).max(8),
    rows: UiSchema.z.array(UiSchema.z.array(uiScalar).max(8)).max(50).default([]),
    rowEntities: UiSchema.z.array(UiSchema.z.string().max(200)).max(50).optional(),
    pageSize: UiSchema.z.number().int().min(5).max(50).default(10),
    caption: uiText.optional(),
  }).strict(),
  bindProp: 'rows',
  role: 'region', aria: props => ({ label: props.caption || '数据表格' }),
  keyboard: { focusable: true, behavior: 'arrow-scroll' },
  responsive: { rule: 'horizontal-scroll' },
  renderer(props, context) {
    const wrap = context.createElement('div', 'ui-table-wrap');
    wrap.setAttribute('tabindex', '0');
    wrap.setAttribute('data-scroll-key', context.blockId || 'table');
    const table = context.createElement('table', 'ui-table');
    table.setAttribute('role', 'table');
    table.setAttribute('aria-label', props.caption || '数据表格');
    if (props.caption) wrap.appendChild(context.createElement('div', 'ui-caption', props.caption));
    const head = context.createElement('thead');
    const headRow = context.createElement('tr');
    props.columns.forEach(column => {
      const cell = context.createElement('th', '', column);
      cell.setAttribute('scope', 'col');
      headRow.appendChild(cell);
    });
    head.appendChild(headRow);
    table.appendChild(head);
    const body = context.createElement('tbody');
    props.rows.slice(0, props.pageSize).forEach((row, rowIndex) => {
      const line = context.createElement('tr');
      const entityId = props.rowEntities && props.rowEntities[rowIndex]
        ? props.rowEntities[rowIndex] : 'row-' + rowIndex;
      line.setAttribute('data-entity-id', entityId);
      line.setAttribute('data-focus-key', (context.blockId || 'table') + '/' + entityId);
      line.setAttribute('tabindex', '0');
      line.setAttribute('aria-selected', 'false');
      props.columns.forEach((column, index) => {
        const value = row[index] == null ? '' : String(row[index]);
        line.appendChild(context.createElement('td', '', value));
      });
      body.appendChild(line);
    });
    table.appendChild(body);
    wrap.appendChild(table);
    if (props.rows.length > props.pageSize) {
      wrap.appendChild(context.createElement('div', 'ui-summary',
        '还有 ' + (props.rows.length - props.pageSize) + ' 行未显示'));
    }
    return wrap;
  },
});

registerUiComponent('Card', {
  schema: UiSchema.z.object({
    title: uiText,
    body: uiText.optional(),
    fields: UiSchema.z.array(uiLabelValue).max(8).default([]),
    entityKey: uiText.optional(),
    status: UiSchema.z.enum(['normal', 'success', 'warning', 'error']).default('normal'),
  }).strict(),
  bindProp: '$props',
  role: 'group', aria: props => ({ label: props.title }),
  keyboard: { focusable: false, behavior: 'read' },
  responsive: { rule: 'stack' },
  renderer(props, context) {
    const card = context.createElement('section', 'ui-card ui-status-' + props.status);
    const entityId = props.entityKey || 'card';
    card.setAttribute('data-entity-id', entityId);
    card.setAttribute('data-focus-key', (context.blockId || 'card') + '/' + entityId);
    card.setAttribute('tabindex', '0');
    card.setAttribute('aria-selected', 'false');
    card.appendChild(context.createElement('h3', 'ui-card-title', props.title));
    if (props.body) card.appendChild(context.createElement('p', 'ui-card-body', props.body));
    if (props.fields.length) {
      const list = context.createElement('dl', 'ui-keyvalues');
      props.fields.forEach(field => {
        list.appendChild(context.createElement('dt', '', field.label));
        list.appendChild(context.createElement('dd', '', String(field.value ?? '')));
      });
      card.appendChild(list);
    }
    return card;
  },
});

registerUiComponent('KeyValue', {
  schema: UiSchema.z.object({ items: UiSchema.z.array(uiLabelValue).min(1).max(12) }).strict(),
  bindProp: 'items',
  role: 'list', aria: { label: '键值详情' },
  keyboard: { focusable: false, behavior: 'read' }, responsive: { rule: 'wrap' },
  renderer(props, context) {
    const list = context.createElement('dl', 'ui-keyvalues');
    props.items.forEach(item => {
      const row = context.createElement('div', 'ui-keyvalue-row');
      row.setAttribute('role', 'listitem');
      row.appendChild(context.createElement('dt', '', item.label));
      row.appendChild(context.createElement('dd', '', String(item.value ?? '')));
      list.appendChild(row);
    });
    return list;
  },
});

registerUiComponent('Timeline', {
  schema: UiSchema.z.object({
    title: uiText.optional(),
    items: UiSchema.z.array(UiSchema.z.object({
      title: uiText, description: uiText.optional(), time: uiText.optional(),
      entityKey: uiText.optional(),
      status: uiStatus.default('pending'),
    }).strict()).min(1).max(50),
  }).strict(),
  bindProp: 'items',
  role: 'list', aria: props => ({ label: props.title || '时间线' }),
  keyboard: { focusable: false, behavior: 'read-order' }, responsive: { rule: 'vertical' },
  renderer(props, context) {
    const list = context.createElement('ol', 'ui-timeline');
    props.items.forEach((item, index) => {
      const row = context.createElement('li', 'ui-timeline-item ui-status-' + item.status);
      const entityId = item.entityKey || 'step-' + index;
      row.setAttribute('data-entity-id', entityId);
      row.setAttribute('data-focus-key', (context.blockId || 'timeline') + '/' + entityId);
      row.setAttribute('tabindex', '0');
      row.setAttribute('aria-selected', 'false');
      row.setAttribute('role', 'listitem');
      row.appendChild(context.createElement('div', 'ui-timeline-title', item.title));
      if (item.time) row.appendChild(context.createElement('time', 'ui-timeline-time', item.time));
      if (item.description) row.appendChild(context.createElement('p', 'ui-timeline-description', item.description));
      list.appendChild(row);
    });
    return list;
  },
});

registerUiComponent('BarChart', {
  schema: UiSchema.z.object({
    title: uiText.optional(),
    items: UiSchema.z.array(UiSchema.z.object({
      label: uiText, value: UiSchema.z.number().finite().nonnegative(),
    }).strict()).min(1).max(12),
  }).strict(),
  bindProp: 'items',
  role: 'img', aria: props => ({
    label: (props.title || '柱状图') + '：' + props.items.map(item => item.label + ' ' + item.value).join('，'),
  }),
  keyboard: { focusable: false, behavior: 'text-equivalent' }, responsive: { rule: 'scale' },
  renderer(props, context) {
    const figure = context.createElement('figure', 'ui-barchart');
    const max = Math.max(1, ...props.items.map(item => item.value));
    const svg = context.createElementNS('http://www.w3.org/2000/svg', 'svg', 'ui-bars');
    svg.setAttribute('viewBox', '0 0 640 ' + (props.items.length * 36));
    svg.setAttribute('aria-hidden', 'true');
    props.items.forEach((item, index) => {
      const y = index * 36 + 6;
      const label = context.createElementNS('http://www.w3.org/2000/svg', 'text', 'ui-bar-label', item.label);
      label.setAttribute('x', '0'); label.setAttribute('y', String(y + 15));
      const bar = context.createElementNS('http://www.w3.org/2000/svg', 'rect', 'ui-bar-rect');
      bar.setAttribute('x', '180'); bar.setAttribute('y', String(y));
      bar.setAttribute('width', String(item.value / max * 400)); bar.setAttribute('height', '18');
      const value = context.createElementNS('http://www.w3.org/2000/svg', 'text', 'ui-bar-value', String(item.value));
      value.setAttribute('x', '590'); value.setAttribute('y', String(y + 15));
      svg.appendChild(label); svg.appendChild(bar); svg.appendChild(value);
    });
    figure.appendChild(svg);
    figure.appendChild(context.createElement('figcaption', 'ui-caption',
      props.items.map(item => item.label + ' ' + item.value).join('；')));
    return figure;
  },
});

registerUiComponent('TextBlock', {
  schema: UiSchema.z.object({
    text: uiText,
    tone: UiSchema.z.enum(['normal', 'muted', 'error']).default('normal'),
  }).strict(),
  bindProp: 'text',
  role: 'paragraph', aria: { label: '文本内容' },
  keyboard: { focusable: false, behavior: 'read' }, responsive: { rule: 'wrap' },
  renderer(props, context) {
    return context.createElement('p', 'ui-text ui-tone-' + props.tone, props.text);
  },
});

registerUiComponent('EmptyState', {
  schema: UiSchema.z.object({ title: uiText, body: uiText.optional() }).strict(),
  bindProp: '$props',
  role: 'status', aria: props => ({ label: props.title }),
  keyboard: { focusable: false, behavior: 'read' }, responsive: { rule: 'stack' },
  renderer(props, context) {
    const empty = context.createElement('div', 'ui-empty');
    empty.appendChild(context.createElement('strong', 'ui-empty-title', props.title));
    if (props.body) empty.appendChild(context.createElement('p', 'ui-empty-body', props.body));
    return empty;
  },
});

registerUiComponent('Skeleton', {
  schema: UiSchema.z.object({
    lines: UiSchema.z.number().int().min(1).max(12).default(3),
    label: uiText.default('正在加载'),
  }).strict(),
  bindProp: null,
  role: 'status', aria: props => ({ label: props.label, busy: 'true' }),
  keyboard: { focusable: false, behavior: 'wait' }, responsive: { rule: 'stable-size' },
  renderer(props, context) {
    const skeleton = context.createElement('div', 'ui-skeleton');
    skeleton.setAttribute('aria-busy', 'true');
    for (let index = 0; index < props.lines; index++) {
      skeleton.appendChild(context.createElement('span', 'ui-skeleton-line'));
    }
    skeleton.appendChild(context.createElement('span', 'ui-sr-only', props.label));
    return skeleton;
  },
});

const UiComponentRegistry = Object.freeze({
  register: registerUiComponent,
  render: renderUiComponent,
  get(name) { return UI_COMPONENT_DESCRIPTORS[name] || null; },
  names() { return Object.keys(UI_COMPONENT_DESCRIPTORS); },
});
