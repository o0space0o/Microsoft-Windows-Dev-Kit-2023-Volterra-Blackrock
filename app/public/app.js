import { describeProgress, duration, noticeText, messageText } from './progress.js';
const $ = value => document.querySelector(value);
const token = $('meta[name="volterra-session"]').content;
let state, screen = 'desktop', connected = true, phase = '', phaseSince = Date.now(), lastActivity = null, replaying = false;
let pending = null, answers = {}, answerIndex = 0;
const messages = new Map(), loginStarted = { chatgpt: false, github: false }, reported = new Set();
async function action(name, body = {}) {
  const response = await fetch('/api/' + name, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Volterra-Client': token }, body: JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'The action did not complete.');
  return result;
}
function append(type, data, time = new Date().toISOString()) {
  const journal = $('#journal');
  const follow = journal.scrollHeight - journal.scrollTop - journal.clientHeight < 80;
  let key, text;
  if ((type === 'message' || type === 'output') && data?.itemId) {
    key = type + ':' + data.itemId;
    const previous = messages.get(key);
    text = (previous?.text || '') + (data.delta || '');
  } else if (type === 'command') {
    const command = data.command || '';
    const index = command.indexOf(' -Command ');
    text = 'Running: ' + (index < 0 ? command : command.slice(index + 10)).slice(0, 550);
  } else text = typeof data === 'string' ? data : noticeText(data);
  if (!text?.trim()) return;
  let item = key && messages.get(key);
  if (!item) {
    const entry = document.createElement('div'); entry.className = 'entry ' + type;
    const clock = document.createElement('time'); clock.dateTime = time; clock.textContent = new Date(time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const content = document.createElement('span'); entry.append(clock, content); journal.append(entry);
    item = { entry, content, text: '' }; if (key) messages.set(key, item);
  }
  item.text = text.slice(-30000);
  item.content.textContent = type === 'message' ? messageText(item.text) : item.text;
  if (type === 'output') item.entry.scrollTop = item.entry.scrollHeight;
  if (journal.children.length > 300) {
    const removed = journal.firstElementChild; removed.remove();
    for (const [id, value] of messages) if (value.entry === removed) messages.delete(id);
  }
  if (follow || replaying) journal.scrollTop = journal.scrollHeight;
  if (!replaying) lastActivity = Date.now();
  updateClock();
}
function updateClock() {
  if (!state) return;
  const current = describeProgress(state, connected);
  if (!connected) { $('#activity-clock').textContent = 'Waiting for the live connection…'; return; }
  if (!current.active) { $('#activity-clock').textContent = current.phase === 'question' ? 'Waiting for your reply' : 'Progress and conversation are saved'; return; }
  const age = lastActivity ? Date.now() - lastActivity : null;
  $('#activity-clock').textContent = duration(Date.now() - phaseSince) + ' in this step · ' + (age === null ? 'Waiting for the first update' : age < 1500 ? 'Receiving live updates' : age < 30000 ? 'Latest update ' + duration(age) + ' ago' : 'Still running · No new output for ' + duration(age));
}
function renderQuestion(value) {
  const request = value.approvals?.[0] || null;
  if (request?.id !== pending?.id) { pending = request; answers = {}; answerIndex = 0; }
  const box = $('#requests');
  let text = '';
  if (pending?.method === 'item/tool/requestUserInput') {
    const question = pending.params.questions?.[answerIndex];
    if (question) {
      text = question.question;
      if (question.options?.length) text += '\n' + question.options.map(option => option.label + (option.description ? ': ' + option.description : '')).join('\n');
      $('#message').placeholder = 'Your answer…';
    }
  } else if (pending) {
    text = (pending.params.reason || 'Codex needs your permission for this action.') + '\n' + (pending.params.command || JSON.stringify(pending.params.permissions || {})) + '\nReply “allow” or “decline” in the chat.';
    $('#message').placeholder = 'Allow or decline this action…';
  } else if (value.github?.userCode) {
    text = 'GitHub browser sign-in: enter ' + value.github.userCode + ' at github.com/login/device. Work will continue after sign-in.';
  } else if (!value.account) text = 'ChatGPT browser sign-in is required. Say “sign in” to open the official sign-in page.';
  else if (!value.github?.login) text = 'GitHub browser sign-in is required for automatic publishing. Say “connect GitHub” to open it.';
  if (!pending) $('#message').placeholder = 'Talk to Codex while it works…';
  box.textContent = text; box.classList.toggle('hidden', !text);
}
function render(value) {
  state = value;
  const current = describeProgress(value, connected);
  if (current.phase !== phase) {
    phase = current.phase; phaseSince = Date.parse(value.progress?.since) || Date.now();
  }
  if (value.progress?.lastActivityAt) lastActivity = Math.max(lastActivity || 0, Date.parse(value.progress.lastActivityAt));
  $('#workspace').dataset.active = String(current.active);
  $('#workspace').dataset.phase = current.phase;
  $('#panel-title').textContent = current.title;
  $('#status').textContent = (value.runtimeReady ?? value.running ? 'Codex ready' : 'Codex not started') + ' · ' + (value.account ? 'ChatGPT connected' : 'ChatGPT not connected') + ' · ' + (value.github?.login ? 'GitHub connected' : 'GitHub not connected');
  $('#automation-status').textContent = current.detail;
  $('#restart').classList.toggle('hidden', !value.restartRequired);
  $('#restart').textContent = value.automation?.phase === 'restart-pending' ? 'A reviewed helper update is staged. Restart is required to apply it.' : 'This Windows session reports a pending restart.';
  renderQuestion(value); updateClock();
  const problem = value.automation?.lastError;
  if (problem && !reported.has(problem)) { reported.add(problem); append('notice', problem); }
  if (value.automation?.enabled && value.runtimeReady && !value.account && !loginStarted.chatgpt) {
    loginStarted.chatgpt = true; safe(() => action('codex/sign-in'));
  } else if (value.automation?.enabled && value.connectionsChecked && value.account && !value.github?.login && !value.github?.userCode && !loginStarted.github) {
    loginStarted.github = true; safe(() => action('github/sign-in'));
  }
}
function panel() { $('#workspace').classList.remove('hidden'); }
function portal(label, x, y, radius, handler) {
  const button = document.createElement('button'); button.className = 'portal'; button.setAttribute('aria-label', label); button.title = label;
  button.style.left = x / 1672 * 100 + '%'; button.style.top = y / 941 * 100 + '%'; button.style.width = radius * 2 / 1672 * 100 + '%'; button.style.height = radius * 2 / 941 * 100 + '%'; button.onclick = handler; $('#portals').append(button);
}
function navigate(next) {
  screen = next; $('#artwork').src = '/design/' + next + '.png'; $('#artwork').alt = 'Approved ' + next + ' reference artwork'; $('#portals').replaceChildren();
  portal('Home', 39, 88, 26, () => navigate('desktop'));
  portal('System', 40, 215, 26, () => navigate('system'));
  portal('Maintenance', 40, 401, 26, () => navigate('maintenance'));
  portal('Connections', 40, 580, 26, () => { navigate('connections'); panel(); });
  if (next === 'desktop') {
    portal('Open system', 462, 258, 110, () => navigate('system')); portal('Open devices', 1209, 260, 110, panel);
    portal('Open project files', 526, 576, 110, panel); portal('Open maintenance', 1148, 576, 110, () => navigate('maintenance'));
    portal('Open live workspace', 1410, 744, 115, panel);
  } else if (next === 'connections') {
    for (const [label, x, y, r] of [['GitHub connection', 475, 240, 87], ['Codex connection', 833, 233, 87], ['System workspace', 1210, 235, 87], ['ChatGPT connection', 881, 585, 62], ['Saved work', 1308, 625, 82], ['Live progress', 1308, 700, 82]]) portal(label, x, y, r, panel);
  } else if (next === 'maintenance') {
    portal('GitHub and ChatGPT connections', 1460, 100, 75, () => { navigate('connections'); panel(); });
    for (const [label, x] of [['Observe', 339], ['Review', 589], ['Test', 837], ['Release', 1088], ['Restore', 1339]]) portal(label, x, 275, 75, panel);
  } else portal('Open system workspace', 1230, 485, 215, panel);
}
async function safe(callback) {
  try { const result = await callback(); if (result?.userCode) append('notice', 'Enter this one-time code in the official browser: ' + result.userCode); return result; }
  catch (error) { panel(); append('error', error.message); }
}
async function send(text) {
  if (!text.trim()) return;
  const intent = text.trim().toLowerCase();
  if (['pause', 'stop', 'interrupt'].includes(intent)) { append('user', text); await action('automation/pause'); return; }
  if (pending?.method === 'item/tool/requestUserInput') {
    const question = pending.params.questions?.[answerIndex];
    if (!question) throw new Error('This question is no longer pending.');
    answers[question.id] = { answers: [text] }; answerIndex++;
    if (answerIndex < pending.params.questions.length) { renderQuestion(state); return; }
    await action('approval/reply', { id: pending.id, answers }); return;
  }
  if (pending) {
    const reply = text.trim().toLowerCase();
    if (!['allow', 'approve', 'decline', 'deny', 'no'].includes(reply)) throw new Error('Reply “allow” or “decline” for this specific action.');
    await action('approval/reply', { id: pending.id, allow: ['allow', 'approve'].includes(reply) }); return;
  }
  if (['sign in', 'sign in to chatgpt', 'connect chatgpt', 'sign in to codex'].includes(intent)) { append('user', text); await action('codex/sign-in'); return; }
  if (['connect github', 'sign in to github'].includes(intent)) { append('user', text); await action('github/sign-in'); return; }
  if (['continue', 'resume', 'start'].includes(intent)) { append('user', text); await action('automation/resume'); return; }
  await action('agent/send', { text });
}
$('#composer').onsubmit = event => {
  event.preventDefault(); const text = $('#message').value;
  safe(async () => { await send(text); $('#message').value = ''; });
};
$('#message').onkeydown = event => {
  if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); $('#composer').requestSubmit(); }
};
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') $('#workspace').classList.add('hidden');
  if (event.ctrlKey && event.key === String.fromCharCode(96)) { event.preventDefault(); panel(); }
});
const initial = await (await fetch('/api/state')).json();
replaying = true; for (const entry of initial.journal || []) append(entry.type, entry.data, entry.time); replaying = false;
render(initial);
const stream = new EventSource('/api/events');
stream.onopen = () => { connected = true; if (state) render(state); };
stream.onmessage = event => {
  const entry = JSON.parse(event.data); connected = true;
  if (entry.type === 'state') render(entry.data);
  else if (entry.type !== 'approval') append(entry.type, entry.data, entry.time);
};
stream.onerror = () => { connected = false; if (state) render(state); };
setInterval(updateClock, 1000);
const requested = new URL(location.href).searchParams.get('screen');
navigate(requested === 'connections' ? 'connections' : 'desktop');
if (requested === 'connections' || state.automation?.enabled) panel();
window.volterraNavigate = navigate;
