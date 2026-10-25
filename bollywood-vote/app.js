/* Bollywood Night Awards — party voting app.
 *
 * No build step and no server of our own. Votes travel through ntfy.sh, a free
 * public relay: guests post their ballot to a topic named after the party
 * code, and the host's screen reads it back. The relay keeps messages for 12
 * hours, so votes are never lost if the host's phone locks or loses signal —
 * the host catches up the moment the app is open again.
 *
 * A pass-the-phone mode works fully offline on one device.
 */
'use strict';

const RELAY = String(window.BWV_RELAY || 'https://ntfy.sh').replace(/\/+$/, '');
const TOPIC_PREFIX = 'bollywood-night-awards-v2-';
const MAX_MESSAGE_BYTES = 3800;   // ntfy turns bodies over 4 KB into attachments
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const HOST_KEY = 'bwv-host-v2';
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

function voterId() {
  let id = store.get(VOTER_KEY);
  if (!id) { id = randomCode(16); store.set(VOTER_KEY, id); }
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
  toastTimer = setTimeout(() => t.remove(), 3200);
}

function render(...nodes) {
  $('#app').replaceChildren(...nodes);
  window.scrollTo({ top: 0 });
}

/* ---------- relay (ntfy.sh) ---------- */

class RelayError extends Error {
  constructor(kind) {
    super({
      offline: 'No internet connection. Check your signal and try again.',
      busy: 'Too many votes from this Wi-Fi at once. Wait 30 seconds and try again.',
      'too-big': 'That’s too much to send. Shorten the guest list or the award names.',
      server: 'The voting service didn’t respond. Try again in a moment.',
    }[kind] || 'Something went wrong. Try again.');
    this.kind = kind;
  }
}

function topicUrl(code) {
  return `${RELAY}/${TOPIC_PREFIX}${code.toLowerCase()}`;
}

function bytes(str) { return new TextEncoder().encode(str).length; }

async function relayPost(code, payload, onWait) {
  const body = JSON.stringify(payload);
  if (bytes(body) > MAX_MESSAGE_BYTES) throw new RelayError('too-big');
  const res = await relayFetch(topicUrl(code), { method: 'POST', body, cache: 'no-store' }, onWait);
  try { return await res.json(); } catch { return {}; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The relay allows each network a burst of requests, then one more every
// ten seconds. When a whole party votes at once on the same Wi-Fi, keep
// waiting for the allowance to refill (up to four minutes) instead of failing.
async function relayFetch(url, opts, onWait) {
  const giveUpAt = Date.now() + 4 * 60 * 1000;
  for (;;) {
    let res;
    try { res = await fetch(url, opts); } catch { throw new RelayError('offline'); }
    if (res.status === 429 && Date.now() < giveUpAt) {
      if (onWait) onWait();
      await sleep(10500 + Math.random() * 4000);
      continue;
    }
    if (res.status === 429) throw new RelayError('busy');
    if (!res.ok) throw new RelayError('server');
    return res;
  }
}

// One relay line -> { id, time, data } for our own messages, else null.
function parseRelayLine(line) {
  if (!line || !line.trim()) return null;
  let m;
  try { m = JSON.parse(line); } catch { return null; }
  if (!m || m.event !== 'message' || typeof m.message !== 'string') return null;
  let data;
  try { data = JSON.parse(m.message); } catch { return null; }
  if (!data || typeof data !== 'object' || typeof data.t !== 'string') return null;
  return { id: m.id, time: Number(m.time) || 0, data };
}

async function relayPoll(code, since = 'all', onWait) {
  const res = await relayFetch(`${topicUrl(code)}/json?poll=1&since=${encodeURIComponent(since)}`, { cache: 'no-store' }, onWait);
  const text = await res.text();
  return text.split('\n').map(parseRelayLine).filter(Boolean);
}

/* ---------- party data ---------- */

function sanitizeParty(p) {
  p = p || {};
  const nominees = [...new Set((p.nominees || []).map((n) => clean(n, 32)).filter(Boolean))].slice(0, 50);
  const categories = (p.categories || [])
    .map((c, i) => ({ id: clean(c.id, 8) || `c${i}`, title: clean(c.title, 60), hint: clean(c.hint, 100) }))
    .filter((c) => c.title)
    .slice(0, 12);
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

/* ---------- host state & sync ---------- */

let host = null;          // persisted host state
let hostStatus = 'connecting';
let hostStatusMsg = '';
let hostSource = null;    // EventSource for live updates
let hostRetryTimer = null;
let hostRetries = 0;
let hostSyncing = false;
let wakeLock = null;

function saveHost() { if (host) store.set(HOST_KEY, host); }

function newHost(party, mode) {
  host = {
    code: randomCode(),
    mode,                 // 'phones' | 'pass'
    party: sanitizeParty(party),
    ballots: {},          // voterId -> { name, votes, time }
    open: true,
    closedAt: null,       // relay time (seconds) voting closed; later ballots are ignored
    lastId: null,         // last relay message seen
    published: 0,         // when the party details were last posted (ms)
    reveal: { index: 0, opened: false },
    phase: 'voting',      // 'voting' | 'reveal'
  };
  saveHost();
}

function nowSec() { return Math.floor(Date.now() / 1000); }

function recordBallot(id, name, votes, time = nowSec()) {
  const picked = sanitizeVotes(host.party, votes);
  if (!Object.keys(picked).length) return false;
  const prev = host.ballots[id];
  if (prev && prev.time > time) return false;   // keep the newest ballot per voter
  host.ballots[id] = { name: clean(name, 32) || 'Guest', votes: picked, time };
  saveHost();
  return true;
}

function setHostStatus(status, msg = '') {
  hostStatus = status;
  hostStatusMsg = msg;
  const el = $('#host-status');
  if (el) el.replaceWith(statusLine());
}

function handleHostMessage(m) {
  if (!host) return;
  host.lastId = m.id;
  const d = m.data;
  if (d.t === 'ballot') {
    if (host.closedAt && m.time > host.closedAt) { saveHost(); return; }
    const id = clean(d.voter, 40);
    if (id && recordBallot(id, d.name, d.votes, m.time)) refreshHostLobby();
  }
  saveHost();
}

function stopHostSync() {
  clearTimeout(hostRetryTimer);
  hostRetryTimer = null;
  if (hostSource) { hostSource.close(); hostSource = null; }
}

function scheduleHostSync() {
  stopHostSync();
  const delay = Math.min(30000, 2000 * 2 ** hostRetries);
  hostRetries++;
  hostRetryTimer = setTimeout(hostSync, delay);
}

async function publishParty() {
  await relayPost(host.code, { t: 'party', party: host.party, open: host.open });
  host.published = Date.now();
  saveHost();
}

async function hostSync() {
  if (!host || host.mode !== 'phones' || hostSyncing) return;
  hostSyncing = true;
  stopHostSync();
  setHostStatus('connecting');
  try {
    // Re-post the party details before the relay's 12-hour cache drops them.
    if (host.phase === 'voting' && Date.now() - (host.published || 0) > 10 * 3600e3) await publishParty();
    // Catch up on everything sent while this screen was closed or asleep…
    const missed = await relayPoll(host.code, host.lastId || 'all');
    missed.forEach(handleHostMessage);
    // …then listen live.
    const src = new EventSource(`${topicUrl(host.code)}/sse?since=${encodeURIComponent(host.lastId || 'all')}`);
    hostSource = src;
    src.onopen = () => { hostRetries = 0; setHostStatus('live'); };
    src.onmessage = (e) => { const m = parseRelayLine(e.data); if (m) handleHostMessage(m); };
    src.onerror = () => {
      if (hostSource !== src) return;
      setHostStatus('connecting', 'Reconnecting…');
      scheduleHostSync();
    };
  } catch (err) {
    setHostStatus('down', `${err.message} Retrying automatically.`);
    scheduleHostSync();
  } finally {
    hostSyncing = false;
  }
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
  if (host.mode === 'phones' && host.phase === 'voting' && hostStatus !== 'live') {
    hostRetries = 0;
    hostSync();
  }
  if (host.phase === 'voting') keepAwake();
});
window.addEventListener('online', () => {
  if (host && host.mode === 'phones' && host.phase === 'voting' && hostStatus !== 'live') { hostRetries = 0; hostSync(); }
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
  const cats = (saved ? saved.party.categories : DEFAULT_CATEGORIES).map((c) => ({ ...c }));

  const drawCats = () => {
    catsWrap.replaceChildren(...cats.map((c, i) =>
      h('div', { class: 'cat-row' },
        h('input', { type: 'text', value: c.title, maxlength: '60', 'aria-label': `Award ${i + 1}`,
          oninput: (e) => { c.title = e.target.value; } }),
        h('button', { type: 'button', class: 'icon-btn', 'aria-label': `Remove ${c.title || 'award'}`,
          onclick: () => { cats.splice(i, 1); drawCats(); } }, '×'))),
    cats.length < 12 ? h('button', { type: 'button', class: 'btn ghost', onclick: () => {
      cats.push({ title: '', hint: '' }); drawCats();
      const inputs = catsWrap.querySelectorAll('input'); inputs[inputs.length - 1].focus();
    } }, 'Add an award') : null);
  };
  drawCats();

  const submit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const party = sanitizeParty({
      name: nameIn.value,
      nominees: nomineesIn.value.split(/[\n,]/),
      categories: cats.map((c, i) => ({ id: `c${i}`, title: c.title, hint: c.hint })),
    });
    if (party.nominees.length < 2) { err.textContent = 'Add at least two guests as nominees, one per line.'; return; }
    if (!party.categories.length) { err.textContent = 'Add at least one award.'; return; }
    if (bytes(JSON.stringify({ t: 'party', party, open: true })) > MAX_MESSAGE_BYTES) {
      err.textContent = 'That’s too much to send. Shorten the guest list or the award names.';
      return;
    }
    if (saved && Object.keys(saved.ballots).length &&
        !confirm('Starting a new party clears the votes from your last one. Continue?')) return;
    stopHostSync();
    newHost(party, fd.get('mode'));
    const btn = e.submitter;
    if (host.mode === 'phones') {
      if (btn) { btn.disabled = true; btn.textContent = 'Opening voting…'; }
      try { await publishParty(); }
      catch (error) {
        // Keep going: the lobby shows the problem and keeps retrying.
        setHostStatus('down', `${error.message} Retrying automatically.`);
      }
    }
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
            h('span', { class: 'muted small' }, 'Guests scan a QR code on your screen. Needs an internet connection.'))),
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
  if (host.mode === 'phones') { viewHostLobby(); hostRetries = 0; hostSync(); }
  else viewPass();
  keepAwake();
}

function statusLine() {
  const label = hostStatusMsg || { live: 'Ready for votes', connecting: 'Connecting…', down: 'Offline' }[hostStatus];
  return h('div', { class: 'status', id: 'host-status' },
    h('span', { class: `dot ${hostStatus === 'live' ? 'live' : hostStatus === 'down' ? 'down' : ''}` }),
    h('span', null, label));
}

let showTally = false;

function ballotsSummary() {
  const list = Object.values(host.ballots).sort((a, b) => a.time - b.time);
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
      h('button', { class: 'btn ghost', onclick: () => { stopHostSync(); viewHome(); } }, 'Home'),
      h('button', { class: 'btn ghost', onclick: endParty }, 'End party')));
}

function viewHostLobby() {
  const url = joinUrl(host.code);
  const share = async () => {
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
        h('button', { class: 'btn ghost', onclick: share }, 'Share the voting link')),
      ballotsSummary(),
      h('button', { class: 'btn', onclick: () => viewBallot({
        title: 'Your vote',
        party: host.party,
        name: host.ballots.host ? host.ballots.host.name : 'Host',
        votes: host.ballots.host ? host.ballots.host.votes : {},
        onCancel: viewHostLobby,
        onSubmit: (name, votes) => { recordBallot('host', name, votes); toast('Your vote is in'); viewHostLobby(); },
      }) }, host.ballots.host ? 'Change your own vote' : 'Cast your own vote'),
      h('p', { class: 'muted small center' }, 'Votes are saved even if this screen locks. Open the app again to catch up.'),
      hostControls(),
    ),
  );
}

async function closeVoting(e) {
  if (!Object.keys(host.ballots).length && host.mode === 'pass') { toast('No votes yet'); return; }
  if (!confirm('Close voting? Guests won’t be able to vote or change their votes.')) return;
  const btn = e && e.currentTarget;
  host.open = false;
  host.closedAt = nowSec();
  if (host.mode === 'phones') {
    if (btn) { btn.disabled = true; btn.textContent = 'Collecting the last votes…'; }
    try {
      // The relay's own timestamp is the cut-off, so phone clock drift can't drop late votes.
      const posted = await relayPost(host.code, { t: 'status', open: false });
      if (posted && posted.time) host.closedAt = Number(posted.time);
      const missed = await relayPoll(host.code, host.lastId || 'all');
      missed.forEach(handleHostMessage);
    } catch (err) {
      toast(`Couldn’t tell guests voting closed. ${err.message}`);
    }
    stopHostSync();
  }
  host.phase = 'reveal';
  host.reveal = { index: 0, opened: false };
  saveHost();
  viewReveal();
}

async function reopenVoting() {
  host.open = true;
  host.closedAt = null;
  host.phase = 'voting';
  saveHost();
  if (host.mode === 'phones') {
    try { await publishParty(); } catch (err) { toast(`Couldn’t reopen for guests. ${err.message}`); }
  }
  resumeHost();
}

async function endParty() {
  if (!confirm('End the party and delete all votes? This can’t be undone.')) return;
  if (host.mode === 'phones') {
    try { await relayPost(host.code, { t: 'status', open: false, ended: true }); } catch { /* best effort */ }
  }
  stopHostSync();
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

function viewBallot({ title, party, name = '', votes = {}, onSubmit, onCancel }) {
  const err = h('p', { class: 'error', role: 'alert', id: 'ballot-error' });
  let nameIn;
  const submit = (e) => {
    e.preventDefault();
    err.textContent = '';
    const fd = new FormData(e.target);
    const picked = {};
    for (const c of party.categories) { const v = fd.get(c.id); if (v) picked[c.id] = v; }
    const who = clean(nameIn.value, 32);
    if (!who) { err.textContent = 'Add your name so the host knows you voted.'; nameIn.focus(); return; }
    if (!Object.keys(picked).length) { err.textContent = 'Pick a nominee for at least one award.'; return; }
    onSubmit(who, picked, e.submitter, err);
  };

  render(
    h('form', { class: 'stack-lg', onsubmit: submit },
      h('div', { class: 'stack' },
        onCancel ? h('button', { type: 'button', class: 'btn link', onclick: onCancel }, 'Back') : null,
        h('h2', null, title),
        h('p', { class: 'muted' }, 'Your picks stay secret until the host opens the envelopes.')),
      h('label', { class: 'field' },
        h('span', null, 'Your name'),
        nameIn = h('input', { type: 'text', maxlength: '32', value: name, autocomplete: 'given-name' })),
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
  if (!name) nameIn.focus();
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
    render(h('div', { class: 'reveal' },
      h('h2', null, 'No votes to reveal'),
      h('p', { class: 'muted' }, 'Reopen voting so guests can send their picks.'),
      back));
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

function leaveGuest() {
  guest = null;
  history.replaceState(null, '', location.pathname);
  viewHome();
}

// Latest party details and open/closed state from the relay's history.
function partyState(msgs) {
  let party = null, open = true, ended = false;
  for (const m of msgs) {
    if (m.data.t === 'party' && m.data.party) {
      party = sanitizeParty(m.data.party);
      open = m.data.open !== false;
      ended = false;
    } else if (m.data.t === 'status') {
      open = !!m.data.open;
      ended = !!m.data.ended;
    }
  }
  return { party, open, ended };
}

async function startGuest(code) {
  const g = { code, party: null, mine: store.get(BALLOT_KEY + code) };
  guest = g;
  viewGuestMessage('Finding the party…', `Party code ${code}`);
  let state;
  try {
    state = partyState(await relayPoll(code, 'all', () => {
      if (guest === g) viewGuestMessage('Finding the party…', 'Lots of guests are joining at once. Hang tight — this can take a minute or two.');
    }));
  } catch (err) {
    if (guest !== g) return;
    viewGuestMessage('Can’t reach the party', err.message,
      h('div', { class: 'stack' },
        h('button', { class: 'btn', onclick: () => startGuest(code) }, 'Try again'),
        h('button', { class: 'btn ghost', onclick: leaveGuest }, 'Enter a different code')));
    return;
  }
  if (guest !== g) return;
  if (!state.party) {
    viewGuestMessage('Party not found',
      `No party with code ${code}. Check the code on the host’s screen and try again.`,
      h('div', { class: 'stack' },
        h('button', { class: 'btn', onclick: () => startGuest(code) }, 'Try again'),
        h('button', { class: 'btn ghost', onclick: leaveGuest }, 'Enter a different code')));
    return;
  }
  g.party = state.party;
  if (state.ended) { viewGuestMessage('This party has ended', 'Thanks for voting!'); return; }
  if (!state.open) { viewGuestMessage('Voting is closed', 'All eyes on the host. The envelopes are opening.'); return; }
  if (g.mine) viewGuestDone(false); else viewGuestBallot();
}

function viewGuestBallot() {
  const g = guest;
  viewBallot({
    title: g.party.name,
    party: g.party,
    name: g.mine ? g.mine.name : '',
    votes: g.mine ? g.mine.votes : {},
    onSubmit: async (name, votes, btn, err) => {
      if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }
      try {
        await relayPost(g.code, { t: 'ballot', voter: voterId(), name, votes }, () => {
          if (btn) btn.textContent = 'Lots of people voting — still sending…';
        });
      } catch (error) {
        if (guest !== g) return;
        err.textContent = `Your vote wasn’t sent. ${error.message}`;
        if (btn) { btn.disabled = false; btn.textContent = 'Send my vote'; }
        return;
      }
      if (guest !== g) return;
      g.mine = { name, votes };
      store.set(BALLOT_KEY + g.code, g.mine);
      viewGuestDone(true);
    },
  });
}

function viewGuestDone(justSent) {
  viewGuestMessage(justSent ? 'Vote sent!' : 'You’ve voted',
    'Watch the host’s screen for the winners. You can change your picks until voting closes.',
    h('button', { class: 'btn ghost', onclick: () => startGuestEdit() }, 'Change my vote'));
  if (justSent) startPetals(1800);
}

// Re-check the party before editing, in case the host closed voting.
async function startGuestEdit() {
  const g = guest;
  try {
    const state = partyState(await relayPoll(g.code, 'all'));
    if (guest !== g) return;
    if (state.ended) { viewGuestMessage('This party has ended', 'Thanks for voting!'); return; }
    if (!state.open) { viewGuestMessage('Voting is closed', 'All eyes on the host. The envelopes are opening.'); return; }
    if (state.party) g.party = state.party;
  } catch (err) {
    toast(err.message);
    return;
  }
  viewGuestBallot();
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
  store.del('bwv-host-v1');   // state from the old peer-to-peer version
  const room = new URLSearchParams(location.search).get('room');
  if (room && /^[A-Za-z0-9]{5}$/.test(room)) { startGuest(room.toUpperCase()); return; }
  viewHome();
})();
