/* Bollywood Night Awards — party voting app.
 * No build step, no server of our own. Guests on their own phones talk to the
 * host's screen peer-to-peer (WebRTC via the free PeerJS broker). A
 * pass-the-phone mode works fully offline on one device.
 */
'use strict';

const PEER_PREFIX = 'bwnight-awards-';
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const HOST_KEY = 'bwv-host-v1';
const VOTER_KEY = 'bwv-voter-id';
const BALLOT_KEY = 'bwv-ballot-';

const DEFAULT_CATEGORIES = [
  { title: 'Best dressed', hint: 'Red-carpet ready, head to toe.' },
  { title: 'Best dance moves', hint: 'Owned the dance floor tonight.' },
  { title: 'Most filmy entry', hint: 'Walked in like the slow-motion hero shot.' },
  { title: 'Best dialogue delivery', hint: 'Every line landed like a climax scene.' },
  { title: 'Drama queen or king', hint: 'Emotions at full volume, all night long.' },
  { title: 'Life of the party', hint: 'The reason everyone stayed late.' },
];

/* ---------- small helpers ---------- */

const $ = (sel, root = document) => root.querySelector(sel);

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked') el.checked = !!v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

const store = {
  get(key, fallback = null) {
    try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : fallback; }
    catch { return fallback; }
  },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ } },
  del(key) { try { localStorage.removeItem(key); } catch { /* storage unavailable */ } },
};

function randomCode(len = 5) {
  const buf = new Uint32Array(len);
  crypto.getRandomValues(buf);
  return Array.from(buf, (n) => CODE_CHARS[n % CODE_CHARS.length]).join('');
}

function randomId() {
  return (crypto.randomUUID ? crypto.randomUUID() : randomCode(16));
}

function voterId() {
  let id = store.get(VOTER_KEY);
  if (!id) { id = randomId(); store.set(VOTER_KEY, id); }
  return id;
}

function clean(str, max = 40) {
  return String(str || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function joinUrl(code) {
  return `${location.origin}${location.pathname}?room=${code}`;
}

let toastTimer;
function toast(msg) {
  document.querySelectorAll('.toast').forEach((t) => t.remove());
  const t = h('div', { class: 'toast', role: 'status' }, msg);
  document.body.append(t);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.remove(), 2400);
}

function render(...nodes) {
  const app = $('#app');
  app.replaceChildren(...nodes);
  window.scrollTo({ top: 0 });
}

/* ---------- party data ---------- */

function sanitizeParty(p) {
  const nominees = [...new Set((p.nominees || []).map((n) => clean(n, 32)).filter(Boolean))].slice(0, 60);
  const categories = (p.categories || [])
    .map((c, i) => ({ id: clean(c.id, 20) || `c${i}`, title: clean(c.title, 60), hint: clean(c.hint, 120) }))
    .filter((c) => c.title)
    .slice(0, 20);
  return { name: clean(p.name, 60) || 'Bollywood Night', nominees, categories };
}

function sanitizeVotes(party, votes) {
  const out = {};
  for (const c of party.categories) {
    const v = votes && votes[c.id];
    if (typeof v === 'string' && party.nominees.includes(v)) out[c.id] = v;
  }
  return out;
}

function tally(party, ballots) {
  return party.categories.map((cat) => {
    const counts = new Map(party.nominees.map((n) => [n, 0]));
    let total = 0;
    for (const b of Object.values(ballots)) {
      const v = b.votes[cat.id];
      if (counts.has(v)) { counts.set(v, counts.get(v) + 1); total++; }
    }
    const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    const top = ranked.length ? ranked[0][1] : 0;
    const winners = top > 0 ? ranked.filter(([, n]) => n === top).map(([name]) => name) : [];
    return { cat, ranked, total, top, winners };
  });
}

/* ---------- host state ---------- */

let host = null;       // persisted host state
let hostPeer = null;
const hostConns = new Set();
let hostStatus = 'connecting';
let wakeLock = null;

function saveHost() { if (host) store.set(HOST_KEY, host); }

function newHost(party, mode) {
  host = {
    code: randomCode(),
    mode,                 // 'phones' | 'pass'
    party: sanitizeParty(party),
    ballots: {},          // voterId -> { name, votes, at }
    open: true,
    reveal: { index: 0, opened: false },
    phase: 'voting',      // 'voting' | 'reveal'
  };
  saveHost();
}

function recordBallot(id, name, votes) {
  const clean_votes = sanitizeVotes(host.party, votes);
  if (!Object.keys(clean_votes).length) return false;
  host.ballots[id] = { name: clean(name, 32) || 'Guest', votes: clean_votes, at: Date.now() };
  saveHost();
  return true;
}

function partyPayload(forVoter) {
  return {
    t: 'party',
    party: host.party,
    open: host.open,
    mine: forVoter && host.ballots[forVoter] ? host.ballots[forVoter] : null,
  };
}

function broadcast(msg) {
  for (const c of hostConns) { try { c.send(msg); } catch { /* dropped */ } }
}

function startHostPeer(attempt = 0) {
  if (typeof Peer === 'undefined') {
    hostStatus = 'down';
    refreshHostStatus('Couldn’t load the connection library. Check your internet and reload.');
    return;
  }
  if (hostPeer && !hostPeer.destroyed) return;
  hostStatus = 'connecting';
  refreshHostStatus();
  const peer = new Peer(PEER_PREFIX + host.code.toLowerCase());
  hostPeer = peer;

  peer.on('open', () => { hostStatus = 'live'; refreshHostStatus(); });

  peer.on('connection', (conn) => {
    hostConns.add(conn);
    let connVoter = null;
    conn.on('data', (msg) => {
      if (!msg || typeof msg !== 'object' || !host) return;
      if (msg.t === 'hello') {
        connVoter = clean(msg.voterId, 64);
        conn.send(partyPayload(connVoter));
      } else if (msg.t === 'ballot') {
        connVoter = clean(msg.voterId, 64) || connVoter;
        if (!host.open) { conn.send({ t: 'closed' }); return; }
        const ok = connVoter && recordBallot(connVoter, msg.name, msg.votes);
        conn.send(ok ? { t: 'ack' } : { t: 'reject', reason: 'Pick at least one nominee before sending.' });
        if (ok) refreshHostLobby();
      }
    });
    conn.on('close', () => hostConns.delete(conn));
    conn.on('error', () => hostConns.delete(conn));
  });

  peer.on('disconnected', () => {
    hostStatus = 'connecting';
    refreshHostStatus();
    setTimeout(() => { if (!peer.destroyed) peer.reconnect(); }, 1500);
  });

  peer.on('error', (err) => {
    if (err.type === 'unavailable-id' && attempt < 8) {
      // After a reload the broker may still hold our old id for a few seconds.
      peer.destroy();
      hostPeer = null;
      setTimeout(() => startHostPeer(attempt + 1), 3000);
      return;
    }
    if (err.type === 'network' || err.type === 'server-error' || err.type === 'socket-error') {
      hostStatus = 'down';
      refreshHostStatus('Lost the connection. Retrying…');
      peer.destroy();
      hostPeer = null;
      setTimeout(() => startHostPeer(attempt + 1), 4000);
      return;
    }
    if (err.type === 'peer-unavailable') return; // irrelevant on host
    console.warn('Peer error', err);
  });
}

function stopHostPeer() {
  for (const c of hostConns) { try { c.close(); } catch { /* ignore */ } }
  hostConns.clear();
  if (hostPeer) { try { hostPeer.destroy(); } catch { /* ignore */ } }
  hostPeer = null;
}

async function keepAwake() {
  try {
    if ('wakeLock' in navigator && !wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    }
  } catch { /* not supported or denied */ }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !host) return;
  if (host.mode === 'phones') {
    if (!hostPeer || hostPeer.destroyed) startHostPeer();
    else if (hostPeer.disconnected) hostPeer.reconnect();
  }
  if (host.phase === 'voting') keepAwake();
});

/* ---------- views: home ---------- */

function viewHome() {
  const saved = store.get(HOST_KEY);
  let codeInput;
  const err = h('p', { class: 'error', role: 'alert' });
  const join = (e) => {
    e.preventDefault();
    const code = clean(codeInput.value, 8).toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (code.length !== 5) { err.textContent = 'Party codes are 5 characters. Check the host’s screen.'; return; }
    history.replaceState(null, '', `?room=${code}`);
    startGuest(code);
  };

  render(
    h('header', { class: 'marquee' },
      h('h1', null, h('span', null, 'Bollywood'), h('span', { class: 'line-2' }, 'Night Awards')),
      h('p', null, 'Everyone votes from their phone. The host opens the envelopes.')),
    h('div', { class: 'stack-lg' },
      saved ? h('div', { class: 'panel stack' },
        h('h3', null, `Your party: ${saved.party.name}`),
        h('p', { class: 'muted small' }, `${Object.keys(saved.ballots).length} votes in so far.`),
        h('button', { class: 'btn gold', onclick: () => { host = saved; resumeHost(); } }, 'Go back to your party'),
      ) : null,
      h('div', { class: 'stack' },
        h('button', { class: 'btn', onclick: viewSetup }, saved ? 'Host a new party' : 'Host a party'),
      ),
      h('form', { class: 'panel stack', onsubmit: join },
        h('label', { class: 'field' },
          h('span', null, 'Got a party code?'),
          codeInput = h('input', { type: 'text', class: 'code-input', maxlength: '5', autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false', placeholder: 'ABCDE', 'aria-label': 'Party code' })),
        err,
        h('button', { class: 'btn ghost', type: 'submit' }, 'Join and vote')),
      h('p', { class: 'footer-note' }, 'Unofficial fan-made party game. Not affiliated with any film studio or awards show.'),
    ),
  );
}

/* ---------- views: setup ---------- */

function viewSetup() {
  const saved = store.get(HOST_KEY);
  let nameIn, nomineesIn;
  const catsWrap = h('div', { class: 'stack' });
  const err = h('p', { class: 'error', role: 'alert' });
  let cats = (saved ? saved.party.categories : DEFAULT_CATEGORIES).map((c) => ({ ...c }));

  const drawCats = () => {
    catsWrap.replaceChildren(...cats.map((c, i) =>
      h('div', { class: 'cat-row' },
        h('input', { type: 'text', value: c.title, maxlength: '60', 'aria-label': `Award ${i + 1}`,
          oninput: (e) => { c.title = e.target.value; } }),
        h('button', { type: 'button', class: 'icon-btn', 'aria-label': `Remove ${c.title || 'award'}`,
          onclick: () => { cats.splice(i, 1); drawCats(); } }, '×'))),
    h('button', { type: 'button', class: 'btn ghost', onclick: () => {
      cats.push({ title: '', hint: '' }); drawCats();
      const inputs = catsWrap.querySelectorAll('input'); inputs[inputs.length - 1].focus();
    } }, 'Add an award'));
  };
  drawCats();

  const submit = (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const nominees = nomineesIn.value.split(/[\n,]/);
    const party = sanitizeParty({
      name: nameIn.value,
      nominees,
      categories: cats.map((c, i) => ({ id: `c${i}`, title: c.title, hint: c.hint })),
    });
    if (party.nominees.length < 2) { err.textContent = 'Add at least two guests as nominees, one per line.'; return; }
    if (!party.categories.length) { err.textContent = 'Add at least one award.'; return; }
    if (saved && Object.keys(saved.ballots).length &&
        !confirm('Starting a new party clears the votes from your last one. Continue?')) return;
    stopHostPeer();
    newHost(party, fd.get('mode'));
    resumeHost();
  };

  render(
    h('form', { class: 'stack-lg', onsubmit: submit },
      h('div', { class: 'stack' },
        h('button', { type: 'button', class: 'btn link', onclick: viewHome }, 'Back'),
        h('h2', null, 'Set up your awards')),
      h('label', { class: 'field' },
        h('span', null, 'Party name'),
        nameIn = h('input', { type: 'text', maxlength: '60', value: saved ? saved.party.name : 'Bollywood Night' })),
      h('label', { class: 'field' },
        h('span', null, 'Nominees'),
        nomineesIn = h('textarea', { placeholder: 'Priya\nRahul\nAnjali\nVikram', spellcheck: 'false' }),
        h('p', { class: 'hint' }, 'One guest per line. Every guest can be nominated for every award.')),
      h('div', { class: 'field' },
        h('span', { style: 'display:block;font-weight:600;margin-bottom:6px' }, 'Awards'),
        catsWrap),
      h('fieldset', { class: 'choice', style: 'border:0;padding:0;margin:0' },
        h('legend', { style: 'font-weight:600;margin-bottom:6px;padding:0' }, 'How will guests vote?'),
        h('label', null,
          h('input', { type: 'radio', name: 'mode', value: 'phones', checked: true }),
          h('span', null, h('strong', null, 'On their own phones'),
            h('span', { class: 'muted small' }, 'Guests scan a QR code on your screen. Keep your screen open while they vote.'))),
        h('label', null,
          h('input', { type: 'radio', name: 'mode', value: 'pass' }),
          h('span', null, h('strong', null, 'Pass this phone around'),
            h('span', { class: 'muted small' }, 'Each guest votes privately on this device, then hands it on. Works offline.')))),
      err,
      h('button', { class: 'btn gold', type: 'submit' }, 'Open voting'),
    ),
  );
  if (saved) nomineesIn.value = saved.party.nominees.join('\n');
  else nameIn.select();
}

/* ---------- views: host ---------- */

function resumeHost() {
  if (host.phase === 'reveal') { viewReveal(); return; }
  if (host.mode === 'phones') { startHostPeer(); viewHostLobby(); }
  else viewPass();
  keepAwake();
}

function statusLine(extra) {
  const label = { live: 'Ready for votes', connecting: 'Connecting…', down: 'Offline' }[hostStatus];
  return h('div', { class: 'status', id: 'host-status' },
    h('span', { class: `dot ${hostStatus === 'live' ? 'live' : hostStatus === 'down' ? 'down' : ''}` }),
    extra || label);
}

function refreshHostStatus(extra) {
  const el = $('#host-status');
  if (el) el.replaceWith(statusLine(extra));
}

let showTally = false;

function ballotsSummary() {
  const list = Object.values(host.ballots).sort((a, b) => a.at - b.at);
  return h('div', { class: 'panel stack', id: 'host-count' },
    h('div', { class: 'center' },
      h('div', { class: 'count-big' }, list.length),
      h('p', { class: 'muted' }, list.length === 1 ? 'guest has voted' : 'guests have voted')),
    list.length ? h('div', { class: 'voters' }, list.map((b) => h('span', null, b.name))) : null,
    h('button', { class: 'btn link', onclick: () => { showTally = !showTally; refreshHostLobby(); } },
      showTally ? 'Hide the live count' : 'Peek at the live count'),
    showTally ? tallyView() : null,
  );
}

function tallyView() {
  return h('div', { class: 'stack' }, tally(host.party, host.ballots).map((r) =>
    h('div', { class: 'tally' },
      h('h3', null, r.cat.title),
      r.total === 0 ? h('p', { class: 'muted small' }, 'No votes yet.') :
        r.ranked.filter(([, n]) => n > 0).map(([name, n]) =>
          h('div', { class: 'bar' },
            h('span', { class: 'name' }, name),
            h('span', { class: 'track' }, h('span', { class: 'fill', style: `width:${(n / r.top) * 100}%;display:block` })),
            h('span', null, n))))));
}

function refreshHostLobby() {
  const el = $('#host-count');
  if (el) el.replaceWith(ballotsSummary());
}

function qrSvg(text) {
  if (typeof qrcode === 'undefined') return null;
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const wrap = h('div', { class: 'qr', role: 'img', 'aria-label': 'QR code to join the party' });
  wrap.innerHTML = qr.createSvgTag({ cellSize: 6, margin: 2, scalable: true });
  return wrap;
}

function hostControls() {
  return h('div', { class: 'stack' },
    h('button', { class: 'btn gold', onclick: closeVoting }, 'Close voting and reveal winners'),
    h('div', { class: 'btn-row' },
      h('button', { class: 'btn ghost', onclick: () => { stopHostPeer(); viewHome(); } }, 'Home'),
      h('button', { class: 'btn ghost', onclick: endParty }, 'End party')));
}

function viewHostLobby() {
  const url = joinUrl(host.code);
  const copy = async () => {
    try {
      if (navigator.share) await navigator.share({ title: host.party.name, text: `Vote in the ${host.party.name} awards`, url });
      else { await navigator.clipboard.writeText(url); toast('Link copied'); }
    } catch { /* share cancelled */ }
  };
  render(
    h('div', { class: 'stack-lg' },
      h('div', { class: 'center stack' },
        h('h2', null, host.party.name),
        h('p', { class: 'muted' }, 'Scan to vote, or open the site and type this code.')),
      h('div', { class: 'panel stack' },
        qrSvg(url),
        h('div', { class: 'room-code', 'aria-label': `Party code ${host.code.split('').join(' ')}` }, host.code),
        statusLine(),
        h('button', { class: 'btn ghost', onclick: copy }, 'Share the voting link')),
      ballotsSummary(),
      h('button', { class: 'btn', onclick: () => viewBallot({
        title: 'Your vote',
        party: host.party,
        name: host.ballots['host'] ? host.ballots['host'].name : 'Host',
        votes: host.ballots['host'] ? host.ballots['host'].votes : {},
        onCancel: viewHostLobby,
        onSubmit: (name, votes) => { recordBallot('host', name, votes); toast('Your vote is in'); viewHostLobby(); },
      }) }, host.ballots['host'] ? 'Change your own vote' : 'Cast your own vote'),
      h('p', { class: 'muted small center' }, 'Keep this screen open. Guests’ votes come in through it.'),
      hostControls(),
    ),
  );
}

function closeVoting() {
  if (!Object.keys(host.ballots).length) { toast('No votes yet'); return; }
  if (!confirm('Close voting? Guests won’t be able to vote or change their votes.')) return;
  host.open = false;
  host.phase = 'reveal';
  host.reveal = { index: 0, opened: false };
  saveHost();
  broadcast({ t: 'closed' });
  viewReveal();
}

function reopenVoting() {
  host.open = true;
  host.phase = 'voting';
  saveHost();
  broadcast(partyPayload(null));
  resumeHost();
}

function endParty() {
  if (!confirm('End the party and delete all votes? This can’t be undone.')) return;
  broadcast({ t: 'closed' });
  stopHostPeer();
  store.del(HOST_KEY);
  host = null;
  if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
  viewHome();
}

/* ---------- views: pass the phone ---------- */

function viewPass(lastName) {
  const n = Object.keys(host.ballots).length;
  render(
    h('div', { class: 'stack-lg' },
      h('div', { class: 'center stack' },
        h('h2', null, host.party.name),
        lastName ? h('p', null, `Thanks, ${lastName}. Hand the phone to the next guest.`)
          : h('p', { class: 'muted' }, 'Hand the phone to the first guest.')),
      h('div', { class: 'panel center' },
        h('div', { class: 'count-big' }, n),
        h('p', { class: 'muted' }, n === 1 ? 'guest has voted' : 'guests have voted')),
      h('button', { class: 'btn', onclick: () => viewBallot({
        title: 'Your vote',
        party: host.party,
        askName: true,
        onCancel: () => viewPass(),
        onSubmit: (name, votes) => {
          const id = 'local-' + name.toLowerCase();
          if (host.ballots[id] && !confirm(`${name} already voted. Replace their vote?`)) return;
          recordBallot(id, name, votes);
          viewPass(name);
        },
      }) }, 'I’m next — let me vote'),
      hostControls(),
    ),
  );
}

/* ---------- views: ballot (shared by guest, host and pass mode) ---------- */

function viewBallot({ title, party, name = '', votes = {}, askName = true, onSubmit, onCancel, note }) {
  let nameIn;
  const err = h('p', { class: 'error', role: 'alert' });
  const submit = (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const picked = {};
    for (const c of party.categories) { const v = fd.get(c.id); if (v) picked[c.id] = v; }
    const who = askName ? clean(nameIn.value, 32) : name;
    if (askName && !who) { err.textContent = 'Add your name so the host knows you voted.'; nameIn.focus(); return; }
    if (!Object.keys(picked).length) { err.textContent = 'Pick a nominee for at least one award.'; return; }
    onSubmit(who, picked, e.submitter);
  };

  render(
    h('form', { class: 'stack-lg', onsubmit: submit },
      h('div', { class: 'stack' },
        onCancel ? h('button', { type: 'button', class: 'btn link', onclick: onCancel }, 'Back') : null,
        h('h2', null, title),
        h('p', { class: 'muted' }, note || 'Your picks stay secret until the host opens the envelopes.')),
      askName ? h('label', { class: 'field' },
        h('span', null, 'Your name'),
        nameIn = h('input', { type: 'text', maxlength: '32', value: name, autocomplete: 'given-name' })) : null,
      party.categories.map((c) =>
        h('fieldset', { class: 'ballot-cat panel' },
          h('legend', null, h('h3', null, c.title)),
          c.hint ? h('p', { class: 'cat-hint' }, c.hint) : null,
          h('div', { class: 'chips' }, party.nominees.map((n) =>
            h('label', { class: 'chip' },
              h('input', { type: 'radio', name: c.id, value: n, checked: votes[c.id] === n }),
              h('span', null, n)))))),
      err,
      h('button', { class: 'btn gold', type: 'submit' }, 'Send my vote'),
    ),
  );
  if (askName && !name) nameIn.focus();
}

/* ---------- views: reveal ---------- */

function viewReveal() {
  stopPetals();
  const results = tally(host.party, host.ballots).filter((r) => r.total > 0);
  const { index, opened } = host.reveal;

  const go = (i, o) => { host.reveal = { index: i, opened: o }; saveHost(); viewReveal(); };
  const back = h('div', { class: 'btn-row' },
    h('button', { class: 'btn link', onclick: () => {
      if (confirm('Reopen voting? Guests can vote again and the reveal starts over.')) reopenVoting();
    } }, 'Reopen voting'),
    index > 0 || opened ? h('button', { class: 'btn link', onclick: () => go(0, false) }, 'Start reveal over') : null);

  if (!results.length) {
    render(h('div', { class: 'reveal' }, h('h2', null, 'No votes to reveal'), back));
    return;
  }

  if (index >= results.length) {
    render(
      h('div', { class: 'stack-lg finale' },
        h('div', { class: 'center stack' },
          h('h2', null, 'Tonight’s winners'),
          h('p', { class: 'muted' }, host.party.name)),
        h('ul', { class: 'panel' }, results.map((r) =>
          h('li', null,
            h('div', { class: 'cat' }, r.cat.title),
            h('div', { class: 'who' }, r.winners.join(' & '))))),
        h('div', { class: 'stack' },
          h('button', { class: 'btn ghost', onclick: () => go(results.length - 1, true) }, 'Back'),
          h('button', { class: 'btn', onclick: endParty }, 'End party and clear votes'),
          back)));
    startPetals();
    return;
  }

  const r = results[index];
  const progress = h('p', { class: 'progress' }, `Award ${index + 1} of ${results.length}`);
  if (!opened) {
    render(
      h('div', { class: 'reveal' },
        progress,
        h('p', { class: 'award-for' }, 'And the award for'),
        h('p', { class: 'award-title' }, r.cat.title),
        h('p', { class: 'award-for' }, 'goes to…'),
        h('div', { class: 'envelope', 'aria-hidden': 'true' }),
        h('button', { class: 'btn gold', onclick: () => go(index, true) }, 'Open the envelope'),
        back));
    return;
  }

  const tie = r.winners.length > 1;
  render(
    h('div', { class: 'reveal' },
      progress,
      h('p', { class: 'award-title' }, r.cat.title),
      tie ? h('p', { class: 'award-for' }, 'It’s a tie!') : null,
      h('p', { class: 'winner-name' }, r.winners.join(' & ')),
      h('p', { class: 'winner-votes' }, `${r.top} of ${r.total} ${r.total === 1 ? 'vote' : 'votes'}`),
      h('div', { class: 'btn-row' },
        h('button', { class: 'btn ghost', onclick: () => go(index, false) }, 'Back'),
        h('button', { class: 'btn', onclick: () => go(index + 1, false) },
          index + 1 < results.length ? 'Next award' : 'See all winners')),
      back));
  startPetals();
}

/* ---------- guest ---------- */

let guest = null;

function viewGuestMessage(title, body, actions) {
  render(h('div', { class: 'reveal' },
    h('h2', null, title),
    body ? h('p', { class: 'muted' }, body) : null,
    actions || null));
}

function startGuest(code) {
  if (guest && guest.peer) { try { guest.peer.destroy(); } catch { /* ignore */ } }
  guest = { code, peer: null, conn: null, party: null, open: true, mine: store.get(BALLOT_KEY + code), retries: 0, sending: false };
  viewGuestMessage('Finding the party…', `Party code ${code}`);
  if (typeof Peer === 'undefined') {
    viewGuestMessage('Can’t connect', 'The connection library didn’t load. Check your internet and reload the page.',
      h('button', { class: 'btn', onclick: () => location.reload() }, 'Reload'));
    return;
  }
  guestConnect();
}

function guestConnect() {
  const g = guest;
  if (!g.peer || g.peer.destroyed) {
    g.peer = new Peer();
    g.peer.on('open', () => openConn(g));
    g.peer.on('error', (err) => {
      if (guest !== g) return;
      if (err.type === 'peer-unavailable') {
        viewGuestMessage('Party not found',
          `No open party with code ${g.code}. Check the code on the host’s screen, and make sure their screen is still open.`,
          h('div', { class: 'stack' },
            h('button', { class: 'btn', onclick: () => startGuest(g.code) }, 'Try again'),
            h('button', { class: 'btn ghost', onclick: () => { history.replaceState(null, '', location.pathname); viewHome(); } }, 'Enter a different code')));
      } else {
        retryGuest(g);
      }
    });
  } else if (g.peer.open) {
    openConn(g);
  }
}

function openConn(g) {
  const conn = g.peer.connect(PEER_PREFIX + g.code.toLowerCase(), { reliable: true });
  g.conn = conn;
  const timeout = setTimeout(() => { if (!conn.open) retryGuest(g); }, 12000);
  conn.on('open', () => {
    clearTimeout(timeout);
    g.retries = 0;
    conn.send({ t: 'hello', voterId: voterId() });
  });
  conn.on('data', (msg) => onGuestData(g, msg));
  conn.on('close', () => { if (guest === g && g.open) retryGuest(g); });
}

function retryGuest(g) {
  if (guest !== g) return;
  g.retries++;
  if (g.retries > 4) {
    viewGuestMessage('Lost the party', 'Can’t reach the host’s screen. Ask the host to keep the app open, then try again.',
      h('button', { class: 'btn', onclick: () => startGuest(g.code) }, 'Try again'));
    return;
  }
  setTimeout(() => {
    if (guest !== g) return;
    if (g.peer && g.peer.disconnected && !g.peer.destroyed) g.peer.reconnect();
    if (g.peer && g.peer.open) openConn(g);
    else guestConnect();
  }, 1500 * g.retries);
}

function onGuestData(g, msg) {
  if (guest !== g || !msg || typeof msg !== 'object') return;
  if (msg.t === 'party') {
    const first = !g.party;
    g.party = sanitizeParty(msg.party);
    g.open = !!msg.open;
    if (msg.mine) g.mine = msg.mine;
    if (!g.open) { guestClosed(); return; }
    // Only redraw when arriving or coming back from "closed", so a reconnect
    // never wipes picks the guest is in the middle of making.
    if (first || g.wasClosed) {
      g.wasClosed = false;
      if (g.mine) viewGuestDone(); else viewGuestBallot();
    }
  } else if (msg.t === 'ack') {
    g.sending = false;
    store.set(BALLOT_KEY + g.code, g.mine);
    viewGuestDone(true);
  } else if (msg.t === 'reject') {
    g.sending = false;
    toast(msg.reason || 'Vote not accepted');
    viewGuestBallot();
  } else if (msg.t === 'closed') {
    g.open = false;
    guestClosed();
  }
}

function viewGuestBallot() {
  const g = guest;
  viewBallot({
    title: g.party.name,
    party: g.party,
    name: g.mine ? g.mine.name : '',
    votes: g.mine ? g.mine.votes : {},
    onSubmit: (name, votes, btn) => {
      if (!g.conn || !g.conn.open) { toast('Reconnecting… try again in a moment'); retryGuest(g); return; }
      g.mine = { name, votes };
      g.sending = true;
      if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }
      g.conn.send({ t: 'ballot', voterId: voterId(), name, votes });
    },
  });
}

function viewGuestDone(justSent) {
  viewGuestMessage(justSent ? 'Vote sent!' : 'You’ve voted',
    'Watch the host’s screen for the winners. You can change your picks until voting closes.',
    h('button', { class: 'btn ghost', onclick: viewGuestBallot }, 'Change my vote'));
  if (justSent) startPetals(1800);
}

function guestClosed() {
  guest.wasClosed = true;
  viewGuestMessage('Voting is closed', 'All eyes on the host. The envelopes are opening.');
}

/* ---------- marigold petal shower ---------- */

let petalRaf = null;
function startPetals(duration = 3200) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const canvas = $('#petals');
  const ctx = canvas.getContext('2d');
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = innerWidth * dpr;
  canvas.height = innerHeight * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const colors = ['#F5A524', '#F7D774', '#E2266F', '#FF8A1F', '#FFF3DC'];
  const petals = Array.from({ length: 110 }, () => ({
    x: Math.random() * innerWidth,
    y: -20 - Math.random() * innerHeight * 0.6,
    r: 4 + Math.random() * 6,
    vy: 1.5 + Math.random() * 2.5,
    vx: -1 + Math.random() * 2,
    a: Math.random() * Math.PI,
    va: -0.08 + Math.random() * 0.16,
    c: colors[(Math.random() * colors.length) | 0],
  }));
  const end = performance.now() + duration;
  cancelAnimationFrame(petalRaf);
  const frame = (now) => {
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    let alive = 0;
    for (const p of petals) {
      p.x += p.vx + Math.sin(p.a) * 0.6;
      p.y += p.vy;
      p.a += p.va;
      if (now < end && p.y > innerHeight + 20) { p.y = -20; p.x = Math.random() * innerWidth; }
      if (p.y < innerHeight + 20) alive++;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.a);
      ctx.fillStyle = p.c;
      ctx.beginPath();
      ctx.ellipse(0, 0, p.r, p.r * 0.55, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
    if (alive) petalRaf = requestAnimationFrame(frame);
    else ctx.clearRect(0, 0, innerWidth, innerHeight);
  };
  petalRaf = requestAnimationFrame(frame);
}
function stopPetals() {
  cancelAnimationFrame(petalRaf);
  const canvas = $('#petals');
  canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
}

/* ---------- boot ---------- */

(function boot() {
  const room = new URLSearchParams(location.search).get('room');
  if (room && /^[A-Za-z0-9]{5}$/.test(room)) { startGuest(room.toUpperCase()); return; }
  viewHome();
})();
