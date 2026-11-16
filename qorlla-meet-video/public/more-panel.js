const byId = id => document.getElementById(id);
const node = (tag, value, className) => { const element = document.createElement(tag); if (value !== undefined) element.textContent = value; if (className) element.className = className; return element; };

export function initMorePanel({ state, api, notify, openTab, applyDevices }) {
  let current, loaded = false, alive = true, refreshVersion = 0, timer = null, seconds = 300, initialSeconds = 300;
  const ready = fetch(new URL('./more-panel.html', import.meta.url)).then(response => { if (!response.ok) throw Error('Meeting tools unavailable.'); return response.text(); }).then(html => {
    const root = byId('meet-more'); root.innerHTML = html; root.classList.add('more-panel'); root.removeAttribute('aria-busy'); loaded = true; wire();
  }).catch(() => { byId('meet-more').textContent = 'Meeting tools could not load. Please reload when connected.'; });
  const path = suffix => '/meetings/' + state.meetingId + '/more' + suffix;
  const setVisible = (id, visible) => byId(id).classList.toggle('hidden', !visible);
  const attempt = async work => { try { return await work(); } catch (error) { notify(error.message || 'Unable to update meeting.'); return null; } };
  async function refresh() {
    await ready; if (!loaded || !state.meetingId || !alive) return;
    const version = ++refreshVersion;
    try {
      const result = await api(path(''));
      if (version !== refreshVersion || !alive) return;
      current = result; render();
    } catch { byId('more-status').textContent = 'Meeting tools are temporarily unavailable.'; current = null; disableProtected(); }
  }
  function disableProtected() {
    for (const id of ['more-qa-toggle','more-guest-chat','more-allow-reactions','more-lock','more-grant-cohost','more-revoke-cohost']) byId(id).disabled = true;
    byId('more-question-form').querySelector('button').disabled = true;
    setVisible('more-manager-controls', false);
  }
  function render() {
    byId('more-status').textContent = current.available ? 'Meeting tools ready · ' + (current.canManage ? 'Host controls' : 'Participant view') : 'Some tools are unavailable for this meeting.';
    byId('more-role').textContent = current.isHost ? 'You are the host. Only you can assign co-hosts.' : current.canManage ? 'You are an authorized co-host.' : 'Your host manages meeting permissions.';
    byId('more-qa-toggle').disabled = !current.available;
    byId('more-question-form').querySelector('button').disabled = !current.available;
    setVisible('more-manager-controls', current.canManage);
    setVisible('more-cohost-controls', current.isHost && current.available);
    byId('more-guest-chat').checked = current.permissions.guestChat;
    byId('more-allow-reactions').checked = current.permissions.reactions;
    byId('more-guest-chat').disabled = byId('more-allow-reactions').disabled = !current.available || !current.canManage;
    byId('more-lock').disabled = !current.canManage;
    byId('more-security-events').hidden = !current.canManage;
    for (const button of document.querySelectorAll('[data-more-reaction]')) button.disabled = !current.permissions.reactions;
    const chatText = byId('chatText'), chatSend = [...(byId('chatForm')?.elements || [])].find(element => element.tagName === 'BUTTON' && element.type === 'submit');
    const chatDisabled = !current.permissions.guestChat && !current.canManage;
    if (chatText) { chatText.disabled = chatDisabled; chatText.placeholder = chatDisabled ? 'Chat is restricted by the host' : 'Message everyone…'; }
    if (chatSend) chatSend.disabled = chatDisabled;
    document.dispatchEvent(new CustomEvent('qorlla:meet-permissions', { detail: { meetingId: state.meetingId, occurrenceId: current.occurrenceId, canManage: current.canManage, isHost: current.isHost, ...current.permissions } }));
    for (const id of ['saveNotes','pollForm','endBtn']) byId(id)?.classList.toggle('hidden', !current.canManage);
    if (byId('notes') && typeof byId('notes').readOnly === 'boolean') byId('notes').readOnly = !current.canManage;
    const select = byId('more-cohost'), selected = select.value; select.replaceChildren();
    for (const participant of current.participants.filter(person => person.role !== 'host')) { const option = node('option', participant.name + (participant.role === 'cohost' ? ' · co-host' : '')); option.value = participant.id; select.append(option); }
    if ([...select.options].some(option => option.value === selected)) select.value = selected;
    byId('more-grant-cohost').disabled = byId('more-revoke-cohost').disabled = !select.options.length;
    renderQuestions();
    byId('more-events').replaceChildren(...current.events.map(event => node('div', event.event_type.replaceAll('.', ' › ') + ' · ' + new Date(event.created_at).toLocaleTimeString(), 'more-event')));
    if (!current.events.length) byId('more-events').append(node('p', current.available ? 'No recent security events.' : 'Security history is unavailable.', 'more-hint'));
  }
  const actionButton = (label, work) => { const button = node('button', label); button.type = 'button'; button.onclick = () => attempt(async () => { button.disabled = true; try { await work(); await refresh(); } finally { if (button.isConnected) button.disabled = false; } }); return button; };
  function renderQuestions() {
    const list = byId('more-questions'); list.replaceChildren();
    for (const question of current.questions) {
      const card = node('article', undefined, 'more-question');
      card.append(node('span', question.status, 'more-badge'), node('small', question.author + (question.own ? ' · you' : '')), node('p', question.question));
      if (question.answer) card.append(node('p', question.answer, 'more-answer'));
      const actions = node('div', undefined, 'more-inline');
      if (['published','answered'].includes(question.status)) actions.append(actionButton((question.voted ? '✓ ' : '↑ ') + question.votes + ' upvotes', () => api(path('/questions/' + question.id + '/vote'), 'PUT', { active: !question.voted })));
      if (current.canManage) {
        if (question.status === 'pending') actions.append(actionButton('Publish', () => api(path('/questions/' + question.id), 'PATCH', { status: 'published' })));
        if (question.status !== 'dismissed') {
          const answer = node('textarea'); answer.rows = 2; answer.maxLength = 2000; answer.placeholder = 'Write an answer'; answer.setAttribute('aria-label', 'Answer: ' + question.question); answer.value = question.answer;
          card.append(answer);
          actions.append(actionButton('Mark answered', () => api(path('/questions/' + question.id), 'PATCH', { status: 'answered', answer: answer.value })), actionButton('Dismiss', () => api(path('/questions/' + question.id), 'PATCH', { status: 'dismissed' })));
        }
      }
      card.append(actions); list.append(card);
    }
    if (!current.questions.length) list.append(node('p', 'No questions yet. Start the conversation.', 'more-hint'));
  }
  async function updatePermissions() {
    const result = await attempt(() => api(path('/permissions'), 'PATCH', { guestChat: byId('more-guest-chat').checked, reactions: byId('more-allow-reactions').checked }));
    if (result) notify('Meeting permissions updated.'); await refresh();
  }
  const drawTimer = () => { byId('more-timer-output').textContent = String(Math.floor(seconds / 60)).padStart(2, '0') + ':' + String(seconds % 60).padStart(2, '0'); };
  function stopTimer() { clearInterval(timer); timer = null; if (loaded) byId('more-timer-start').textContent = 'Start'; }
  async function devices() {
    const selects = { audioinput: byId('more-microphone'), videoinput: byId('more-camera') };
    Object.values(selects).forEach(select => { const option = node('option', 'Keep current device'); option.value = ''; select.replaceChildren(option); });
    if (!navigator.mediaDevices?.enumerateDevices) { byId('more-apply-devices').disabled = true; return; }
    try {
      for (const device of await navigator.mediaDevices.enumerateDevices()) {
        const select = selects[device.kind]; if (!select) continue;
        const option = node('option', device.label || (device.kind === 'audioinput' ? 'Microphone' : 'Camera') + ' ' + select.options.length); option.value = device.deviceId; select.append(option);
      }
    } catch { notify('Device selection is unavailable. Check browser permissions.'); }
    byId('more-apply-devices').disabled = !Object.values(selects).some(select => select.options.length > 1);
  }
  async function diagnostics() {
    const rtts = []; let lost = 0, received = 0;
    for (const pc of state.peers.values()) {
      const report = await pc.getStats();
      report.forEach(sample => {
        if (sample.type === 'candidate-pair' && sample.state === 'succeeded' && Number.isFinite(sample.currentRoundTripTime)) rtts.push(Math.round(sample.currentRoundTripTime * 1000));
        if (sample.type === 'inbound-rtp' && !sample.isRemote) { lost += Math.max(0, sample.packetsLost || 0); received += sample.packetsReceived || 0; }
      });
    }
    byId('more-diagnostics').textContent = rtts.length || received ? `${state.peers.size} peer(s) · RTT ${rtts.length ? Math.max(...rtts) + ' ms' : 'not sampled'} · ${lost} lost / ${received} received packets. Measured now.` : 'No remote media sample yet. Join with another participant, then refresh.';
  }
  function wire() {
    const icons = [
      '<circle cx="9" cy="8" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3M16 5a3 3 0 0 1 0 6m3 10v-3a6 6 0 0 0-2-4"/>',
      '<path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3Zm8-1v4m-2-2h4"/>',
      '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M8 2v6m8-6v6M3 11h18m-14 4h3m4 0h3m-10 3h3"/>',
      '<path d="m12 2 8 3v6c0 6-8 11-8 11S4 17 4 11V5l8-3Z"/>',
      '<path d="M4 3v8m0 4v6m8-18v3m0 4v11m8-18v11m0 4v3M1 11h6m2-5h6m2 8h6"/>'
    ];
    document.querySelectorAll('.more-group-icon').forEach((element,index) => { element.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + icons[index] + '</svg>'; });
    if (window.matchMedia('(max-width:600px)').matches) document.querySelectorAll('.more-group').forEach(group => { group.open = false; });
    byId('more-qa-toggle').onclick = () => { const open = byId('more-qa').classList.toggle('hidden') === false; byId('more-qa-toggle').setAttribute('aria-expanded', String(open)); byId('more-qa-toggle').textContent = open ? 'Close' : 'Open'; if (open) byId('more-question').focus(); };
    byId('more-question-form').onsubmit = event => { event.preventDefault(); attempt(async () => { const result = await api(path('/questions'), 'POST', { question: byId('more-question').value }); byId('more-question').value = ''; notify(result.pending ? 'Question submitted for review.' : 'Question published.'); await refresh(); }); };
    for (const button of document.querySelectorAll('[data-more-reaction]')) button.onclick = () => state.socket?.timeout(5000).emit('reaction', button.dataset.moreReaction, (error, result) => { if (error || !result?.ok) notify(result?.error || 'Reaction could not be sent.'); });
    byId('more-invite').onclick = () => byId('copyLink').click();
    byId('more-info').onclick = () => {
      const content = byId('more-info-content'); content.replaceChildren();
      for (const [label, value] of [['Meeting',byId('roomTitle').textContent],['Meeting ID',byId('roomId').textContent],['Occurrence',current?.occurrenceId || 'Not available'],['Your role',current?.isHost ? 'Host' : current?.canManage ? 'Co-host' : 'Participant']]) content.append(node('dt',label),node('dd',value));
      byId('more-info-dialog').showModal();
    };
    byId('more-guest-chat').onchange = byId('more-allow-reactions').onchange = updatePermissions;
    for (const [id, active] of [['more-grant-cohost',true],['more-revoke-cohost',false]]) byId(id).onclick = () => attempt(async () => { await api(path('/cohosts/' + byId('more-cohost').value),'PUT',{ active }); await refresh(); notify('Participant role updated.'); });
    byId('more-lock').onchange = () => attempt(async () => { try { const result = await api('/meetings/' + state.meetingId + '/lock','POST',{ locked: byId('more-lock').checked }); byId('more-lock').checked = result.locked; notify(result.locked ? 'Meeting locked. Current participants stay connected.' : 'Meeting unlocked.'); } catch (error) { byId('more-lock').checked = !byId('more-lock').checked; throw error; } });
    byId('more-focus').onchange = event => document.body.classList.toggle('meet-focus',event.target.checked);
    byId('more-large-text').onchange = event => document.body.classList.toggle('meet-large-text',event.target.checked);
    byId('more-reduce-motion').onchange = event => document.body.classList.toggle('meet-reduce-motion',event.target.checked);
    for (const button of document.querySelectorAll('[data-more-layout]')) button.onclick = () => document.querySelector('[data-layout="' + button.dataset.moreLayout + '"]').click();
    byId('more-timer-start').onclick = () => {
      if (timer) { stopTimer(); return; }
      if (seconds === initialSeconds || seconds === 0) { const minutes = Number(byId('more-timer-minutes').value); if (!Number.isInteger(minutes) || minutes < 1 || minutes > 180) { notify('Choose 1–180 minutes.'); return; } seconds = initialSeconds = minutes * 60; }
      const until = Date.now() + seconds * 1000; byId('more-timer-start').textContent = 'Pause'; drawTimer();
      timer = setInterval(() => { seconds = Math.max(0, Math.ceil((until - Date.now()) / 1000)); drawTimer(); if (!seconds) { stopTimer(); notify('Your meeting timer is complete.'); } },250);
    };
    byId('more-timer-reset').onclick = () => { stopTimer(); seconds = initialSeconds = 300; byId('more-timer-minutes').value = 5; drawTimer(); };
    byId('more-refresh-diagnostics').onclick = () => attempt(diagnostics);
    byId('more-apply-devices').onclick = () => attempt(async () => { await applyDevices({ audio: byId('more-microphone').value, video: byId('more-camera').value }); notify('Selected devices applied.'); });
    disableProtected();
  }
  return {
    async enter() { await refresh(); if (loaded) await devices(); },
    connect(socket) { socket.on('more:changed', refresh); socket.on('meeting-locked', ({ locked }) => { if (loaded) byId('more-lock').checked = locked; }); socket.on('connect', refresh); },
    async setLocked(locked) { await ready; if (loaded) byId('more-lock').checked = locked; },
    async openSettings() { await ready; openTab('more'); if (loaded) { const group = byId('more-focus').closest('.more-group'); group.open = true; byId('more-focus').focus(); await devices(); } },
    destroy() { alive = false; stopTimer(); }
  };
}
