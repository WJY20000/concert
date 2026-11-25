const byId = id => document.getElementById(id);
const provider = byId('provider');
const platform = byId('platform');
const mode = byId('mode');
const start = byId('start');
const stop = byId('stop');
const phases = {
  idle: '空闲', running: '运行中', stopping: '正在停止', stopped: '已停止',
  completed: '已完成', failed: '执行失败',
};
const modeInfo = {
  observe: ['开始只读检查', '读取当前页面，检查配置和可见控件。'],
  rehearse: ['开始演练', '按演练流程核验选项，并在最终提交前停止。'],
  live: ['开始真实购票', '将按配置执行选择，并在开售后尝试创建真实待支付订单。'],
};
const events = {
  connected: '已连接', preflight: '已检查页面', waiting: '等待开售或页面就绪',
  first_action: '首次操作', selected: '执行选择', navigated: '操作页面入口',
  submit_attempt: '尝试提交', reconciling: '正在核对订单', confirmed: '确认待支付订单',
  finished: '任务结束',
};
const outcomes = {
  observed: '只读检查完成', rehearsed: '演练已完成', pending_payment: '订单待支付',
  order_status_unknown: '订单状态待人工核对', previous_submission_requires_review: '已有提交记录，请核对订单',
  challenge: '遇到验证', sold_out: '已售罄', wrong_event: '演出不匹配',
  unexpected_submit_label: '提交按钮文案不符', selection_mismatch: '当前选择与配置不符', selection_unavailable: '目标选择不可用',
  login_unverified: '登录状态待核实', page_unrecognized: '无法识别当前页面',
  timeout: '等待超时', invalid_config: '配置有误', adapter_error: '设备或页面操作失败',
  cancelled: '已取消',
};
const stages = { detail: '详情页', options: '票档页', seats: '选座页', checkout: '确认页', order: '订单页', orders: '订单列表' };
const formatter = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai', hourCycle: 'h23', hour: '2-digit', minute: '2-digit',
  second: '2-digit', fractionalSecondDigits: 3,
});
const clockKeys = ['saleAt', 'firstActionAt', 'submitAttemptAt', 'confirmedAt'];
let providers = [];
function syncPlatforms() {
  const enabled = providers.find(item => item.key === provider.value)?.platforms ?? [];
  for (const option of platform.options) option.disabled = !enabled.includes(option.value);
  if (!enabled.includes(platform.value)) platform.value = enabled[0] ?? '';
}
let token = '';
let current = { phase: 'idle', timeline: [] };
let busy = false;
let online = false;
let revision = 0;

function updateControls() {
  const active = ['running', 'stopping'].includes(current.phase);
  start.disabled = active || busy || !online;
  stop.disabled = current.phase !== 'running' || busy || !online;
  provider.disabled = platform.disabled = mode.disabled = active || busy || !online;
  start.textContent = modeInfo[mode.value][0];
  byId('mode-hint').textContent = modeInfo[mode.value][1];
  const indicator = byId('connection');
  indicator.dataset.online = String(online);
  indicator.textContent = online ? '本机已连接' : '等待连接';
}

function render(state) {
  current = state;
  if (['running', 'stopping'].includes(state.phase)) {
    provider.value = state.provider;
    syncPlatforms();
    platform.value = state.platform;
    mode.value = state.mode;
  }
  byId('phase').textContent = phases[state.phase] ?? '未知';
  const times = {};
  const rows = document.createDocumentFragment();
  for (const entry of state.timeline) {
    for (const key of clockKeys) {
      if (entry[key]) times[key] = entry[key];
    }
    if (entry.event === 'first_action') times.firstActionAt ??= entry.at;
    if (entry.event === 'submit_attempt') times.submitAttemptAt ??= entry.at;
    if (entry.event === 'confirmed') times.confirmedAt ??= entry.at;
    if (Number.isSafeInteger(entry.saleToPendingMs)) times.elapsed = entry.saleToPendingMs;
    const item = document.createElement('li');
    const time = document.createElement('time');
    time.dateTime = entry.at;
    time.textContent = formatter.format(new Date(entry.at));
    const message = document.createElement('span');
    message.textContent = [events[entry.event], stages[entry.stage], outcomes[entry.status]].filter(Boolean).join(' · ');
    item.append(time, message);
    rows.prepend(item);
  }
  for (const key of clockKeys) {
    byId(key).textContent = times[key] ? formatter.format(new Date(times[key])) : '—';
    byId(key).title = times[key] ?? '';
  }
  byId('elapsed').textContent = Number.isSafeInteger(times.elapsed) ? times.elapsed + ' ms' : '—';
  byId('timeline').replaceChildren(rows);
  byId('empty').hidden = state.timeline.length > 0;
  updateControls();
}

async function refresh() {
  const observed = revision;
  try {
    const response = await fetch('/api/state');
    if (!response.ok) throw new Error();
    const data = await response.json();
    if (revision !== observed) return;
    online = true;
    const resetProviders = !token || token !== data.token;
    token = data.token;
    if (resetProviders) {
      providers = data.providers;
      provider.replaceChildren(...providers.map(item => new Option(item.key === 'damai' ? '大麦' : item.key, item.key)));
      provider.value = data.defaults.provider;
      syncPlatforms();
      platform.value = data.defaults.platform;
    }
    render(data.run);
  } catch {
    if (revision === observed) {
      online = false;
      updateControls();
    }
  }
}
async function poll() {
  await refresh();
  setTimeout(poll, ['running', 'stopping'].includes(current.phase) ? 500 : 1500);
}
async function command(path, payload) {
  busy = true;
  revision += 1;
  updateControls();
  byId('error').textContent = '';
  try {
    const response = await fetch('/api/' + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Console-Token': token },
      body: JSON.stringify(payload),
    });
    if (!response.ok) throw new Error();
    const data = await response.json();
    revision += 1;
    render(data.run);
  } catch {
    byId('error').textContent = '命令未确认，请先查看当前任务状态。';
  } finally {
    busy = false;
    await refresh();
    updateControls();
  }
}
byId('controls').addEventListener('submit', event => {
  event.preventDefault();
  if (!start.disabled) void command('start', { provider: provider.value, mode: mode.value, platform: platform.value });
});
stop.addEventListener('click', () => {
  if (!stop.disabled) void command('stop', { id: current.id });
});
mode.addEventListener('change', updateControls);
provider.addEventListener('change', syncPlatforms);
updateControls();
void poll();
