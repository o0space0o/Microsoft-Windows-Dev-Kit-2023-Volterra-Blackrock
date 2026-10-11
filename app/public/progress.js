export function describeProgress(state, connected = true) {
  if (!connected) return { phase: 'disconnected', title: 'Reconnecting to the workspace', detail: 'The live connection was lost. Current job progress cannot be confirmed until it reconnects.', active: false };
  if (state.interruptRequested && state.activeTurn) return { phase: 'stopping', title: 'Pausing Codex', detail: 'Waiting for the running job to confirm it has stopped. Progress is saved.', active: true };
  if (state.approvals?.length) return { phase: 'question', title: 'Codex needs your answer', detail: 'Reply in the chat below. Your work is saved while Codex waits.', active: false };
  if (state.systemTool?.kind === 'services') return { phase: 'checking', title: 'Reading Windows services', detail: 'Collecting live service status and startup modes for this OS session.', active: true };
  if (state.systemTool?.kind === 'devices') return { phase: 'checking', title: 'Reading Windows devices', detail: 'Collecting reported device status and problem codes for this OS session.', active: true };
  if (state.systemTool?.kind === 'storage') return { phase: 'checking', title: 'Reading workspace storage', detail: 'Collecting live filesystem capacity for the selected workspace.', active: true };
  if (state.systemTool?.kind === 'networking') return { phase: 'checking', title: 'Reading network addresses', detail: 'Collecting assigned interface addresses for this OS session.', active: true };
  const phase = state.automation?.phase;
  if (state.activeTurn && ['paused', 'blocked', 'restart-pending'].includes(phase)) return { phase: 'replying', title: 'Codex is replying', detail: 'The automatic job is saved while Codex answers your message.', active: true };
  if (phase === 'paused' || state.paused) return { phase: 'paused', title: 'Codex is paused', detail: 'Saved work is retained. Say “continue” whenever you want it to resume.', active: false };
  if (phase === 'blocked') return { phase, title: 'Codex needs a prerequisite', detail: 'Automatic work has stopped. The reason is recorded in the log; you can reply here.', active: false };
  if (phase === 'restart-pending') return { phase, title: 'An update is ready for restart', detail: 'The reviewed helper update is saved. A restart is required to apply it.', active: false };
  if (phase === 'waiting-for-sign-in') return { phase, title: 'Waiting for browser sign-in', detail: 'Complete the official browser sign-in. Codex will continue automatically.', active: false };
  const stages = { reviewing: 'Codex is reviewing the changes', 'reviewing-update': 'Codex is reviewing a GitHub update', checking: 'Running the source checks', publishing: 'Saving the update to GitHub', starting: 'Starting the saved work' };
  if (stages[phase]) return { phase, title: stages[phase], detail: state.automation.taskTitle || 'Continuing the saved project', active: true };
  if (state.activeTurn) return { phase: 'working', title: 'Codex is working', detail: state.automation?.enabled ? state.automation.taskTitle : 'Working on your message', active: true };
  if (phase === 'watching') return { phase, title: 'The saved work queue is finished', detail: 'Watching GitHub for new updates. You can talk to Codex here.', active: false };
  if (state.automation?.enabled) return { phase: 'idle', title: 'Preparing the next step', detail: state.automation.taskTitle || 'Checking for work to continue', active: false };
  return { phase: 'idle', title: 'Ready for your message', detail: 'The log and your conversation stay saved on this device.', active: false };
}

export function duration(milliseconds) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  if (seconds < 60) return seconds + 's';
  return Math.floor(seconds / 60) + 'm ' + seconds % 60 + 's';
}

export function noticeText(data) {
  if (typeof data === 'string') return data;
  if (data?.files) return data.files.map(item => 'Updated ' + item.path.replaceAll('\\', '/').split('/').slice(-2).join('/')).join('\n');
  if (data?.status) return ({ completed: 'Codex finished this step.', interrupted: 'Work paused. Progress is saved.', failed: 'This step stopped: ' + (data.error || 'Codex reported a failure.') })[data.status] || data.status;
  if (data?.fields) return data.fields.error || data.fields.message || '';
  return data?.summary || '';
}

export function messageText(text) {
  if (text.trimStart().startsWith('{')) {
    try { const result = JSON.parse(text); if (typeof result.summary === 'string') return result.summary; } catch { return 'Preparing the work report…'; }
  }
  return text;
}
