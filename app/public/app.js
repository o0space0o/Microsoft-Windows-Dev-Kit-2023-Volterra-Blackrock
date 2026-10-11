const $ = value => document.querySelector(value);
const token = $('meta[name="volterra-session"]').content;
let state, screen = 'desktop';
const messages = new Map();
async function action(name, body = {}) {
  const response = await fetch(`/api/${name}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Volterra-Client': token }, body: JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'The action did not complete.');
  return result;
}
function append(type, data) {
  if ((type === 'message' || type === 'output') && data?.itemId) {
    const key = `${type}:${data.itemId}`;
    let entry = messages.get(key);
    if (!entry) { entry = document.createElement('p'); entry.className = `entry ${type}`; $('#journal').append(entry); messages.set(key, entry); }
    entry.textContent += data.delta || '';
  } else {
    const entry = document.createElement('p'); entry.className = `entry ${type}`;
    entry.textContent = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
    $('#journal').append(entry);
  }
  const journal = $('#journal'); if (journal.children.length > 600) journal.firstElementChild.remove(); journal.scrollTop = journal.scrollHeight;
}
function render(value) {
  state = value;
  $('#status').textContent = `${value.running ? 'Codex ready' : 'Codex not started'} · ${value.account ? 'ChatGPT connected' : 'ChatGPT not connected'} · ${value.github?.login ? `GitHub: ${value.github.login}` : 'GitHub not connected'}\n${value.project?.path || 'No project folder selected'}\n${value.activeTurn ? 'Working · progress streams below' : value.paused ? 'Paused · history saved' : 'Ready for your message'}`;
  $('#plan').textContent = value.account ? `Using ChatGPT plan · ${value.account.source}` : 'Connect ChatGPT to begin';
  $('#restart').classList.toggle('hidden', !value.restartRequired);
  $('#automation-status').textContent = value.automation ? `${value.automation.enabled ? 'Automatic work' : 'Automation ready'} · ${value.automation.phase}\n${value.automation.taskTitle} · GitHub main${value.automation.lastError ? '\n' + value.automation.lastError : ''}` : '';
  if (value.project && document.activeElement !== $('#folder')) $('#folder').value = value.project.path;
  $('#requests').replaceChildren();
  for (const request of value.approvals) {
    const card = document.createElement('div'); card.className = 'request';
    const title = document.createElement('p'); title.textContent = request.method === 'item/tool/requestUserInput' ? 'Codex needs your answer' : 'Codex requests approval';
    const detail = document.createElement('pre'); detail.textContent = JSON.stringify(request.params, null, 2); card.append(title, detail);
    if (request.method === 'item/tool/requestUserInput') {
      const inputs = [];
      for (const question of request.params.questions || []) {
        const label = document.createElement('label'); label.textContent = question.question;
        const input = document.createElement('input'); card.append(label, input); inputs.push([question.id, input]);
      }
      const send = document.createElement('button'); send.textContent = 'Send answer'; send.onclick = () => safe(() => action('approval/reply', { id: request.id, answers: Object.fromEntries(inputs.map(([id, input]) => [id, { answers: [input.value] }])) })); card.append(send);
    } else {
      for (const allow of [true, false]) { const control = document.createElement('button'); control.textContent = allow ? 'Allow this action' : 'Decline'; control.onclick = () => safe(() => action('approval/reply', { id: request.id, allow })); card.append(control); }
    }
    $('#requests').append(card);
  }
}
function panel(title = 'Live workspace', section) {
  $('#panel-title').textContent = title; $('#workspace').classList.remove('hidden');
  if (section) $(section).scrollIntoView({ block: 'nearest' });
}
function portal(label, x, y, radius, handler) {
  const button = document.createElement('button'); button.className = 'portal'; button.setAttribute('aria-label', label); button.title = label;
  button.style.left = `${x / 1672 * 100}%`; button.style.top = `${y / 941 * 100}%`; button.style.width = `${radius * 2 / 1672 * 100}%`; button.style.height = `${radius * 2 / 941 * 100}%`; button.onclick = handler; $('#portals').append(button);
}
function navigate(next) {
  screen = next; $('#artwork').src = `/design/${next}.png`; $('#artwork').alt = `Approved ${next} reference artwork`; $('#portals').replaceChildren();
  portal('Home', 39, 88, 26, () => navigate('desktop'));
  portal('System', 40, 215, 26, () => navigate('system'));
  portal('Maintenance', 40, 401, 26, () => navigate('maintenance'));
  portal('Connections', 40, 580, 26, () => navigate('connections'));
  if (next === 'desktop') {
    portal('Open system', 462, 258, 110, () => navigate('system')); portal('Open devices', 1209, 260, 110, () => panel('Device validation', '#journal'));
    portal('Open project files', 526, 576, 110, () => panel('Project folder', '#project')); portal('Open maintenance', 1148, 576, 110, () => navigate('maintenance'));
    portal('Open live workspace', 1410, 744, 115, () => panel());
  } else if (next === 'connections') {
    portal('Connect GitHub', 475, 240, 87, () => safe(() => { panel('Connections', '#connections'); return action('github/sign-in'); }));
    portal('Connect Codex', 833, 233, 87, () => safe(() => { panel('Connections', '#connections'); return action('codex/connect'); }));
    portal('Open system workspace', 1210, 235, 87, () => panel('System workspace', '#project'));
    portal('Continue with ChatGPT', 881, 585, 62, () => safe(() => { panel('Connections', '#connections'); return action('chatgpt/sign-in'); }));
    portal('Open system workspace', 1308, 625, 82, () => panel('System workspace', '#project'));
    portal('Resume saved work', 1308, 700, 82, () => safe(() => { panel(); return action('project/resume'); }));
  } else if (next === 'maintenance') {
    portal('GitHub and ChatGPT connections', 1460, 100, 75, () => navigate('connections'));
    for (const [label, x] of [['Observe', 339], ['Review', 589], ['Test', 837], ['Release', 1088], ['Restore', 1339]]) portal(label, x, 275, 75, () => panel(label === 'Review' ? 'Review project changes' : 'Maintenance workspace'));
  } else portal('Open system workspace', 1230, 485, 215, () => panel('System workspace'));
}
async function safe(callback) { try { const result = await callback(); if (result?.userCode) append('notice', `Enter this one-time code in the browser: ${result.userCode}`); return result; } catch (error) { panel(); append('error', error.message); } }
const handlers = {
  automatic: () => action('automation/resume'),
  chatgpt: () => action('chatgpt/sign-in'), native: () => action('codex/connect'), 'codex-login': () => action('codex/sign-in'), 'device-login': () => action('codex/sign-in', { device: true }), github: () => action('github/sign-in'), usage: () => action('usage/open'),
  another: () => $('#another-project').classList.toggle('hidden'), browse: () => action('project/open', { browse: true }), open: () => action('project/open', { path: $('#folder').value }), resume: () => action('project/resume'), vision: () => action('agent/vision'),
  pause: () => action('agent/interrupt', { pause: true }), interrupt: () => action('agent/interrupt'), continue: () => action('agent/send', { text: 'Continue from the saved project state and report your progress.' }), review: () => action('agent/review'),
  inspect: async () => append('notice', await action('github/inspect', { repository: $('#repository').value })),
  editor: () => $('#editor').classList.toggle('hidden'), read: async () => { $('#file-content').value = (await action('file/read', { path: $('#file-path').value })).content; }, save: () => action('file/save', { path: $('#file-path').value, content: $('#file-content').value })
};
document.querySelectorAll('[data-action]').forEach(control => { control.onclick = () => safe(handlers[control.dataset.action]); });
$('#close').onclick = () => $('#workspace').classList.add('hidden');
$('#composer').onsubmit = event => { event.preventDefault(); const text = $('#message').value; safe(async () => { await action('agent/send', { text }); $('#message').value = ''; }); };
document.addEventListener('keydown', event => { if (event.key === 'Escape') $('#workspace').classList.add('hidden'); if (event.ctrlKey && event.key === '`') { event.preventDefault(); panel(); } });
const initial = await (await fetch('/api/state')).json(); render(initial); for (const entry of initial.journal) append(entry.type, entry.data);
const stream = new EventSource('/api/events'); stream.onmessage = event => { const entry = JSON.parse(event.data); if (entry.type === 'state') render(entry.data); else if (entry.type !== 'approval') append(entry.type, entry.data); };
stream.onerror = () => { $('#status').textContent = 'Connection lost. Waiting for the local helper to reconnect…'; };
navigate(new URL(location.href).searchParams.get('screen') === 'connections' ? 'connections' : 'desktop');
window.volterraNavigate = navigate;
