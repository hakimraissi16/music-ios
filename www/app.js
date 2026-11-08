(function () {
  'use strict';
  const { registerPlugin, Capacitor } = window.capacitorExports;
  const NativePlayer = registerPlugin('NativePlayer');
  const $ = (id) => document.getElementById(id);

  /* ---------------- log (persisted, so it survives app restarts) ---------------- */
  const LOG_KEY = 'hm_test_log';
  let lines = [];
  try { lines = JSON.parse(localStorage.getItem(LOG_KEY) || '[]'); } catch { lines = []; }
  function stamp(t) {
    const d = t ? new Date(t) : new Date();
    return d.toTimeString().slice(0, 8);
  }
  function log(msg, cls = '', t) {
    const vis = document.visibilityState === 'visible' ? '' : ' [خلفية]';
    lines.push({ s: `${stamp(t)}${vis} ${msg}`, c: cls });
    if (lines.length > 400) lines = lines.slice(-400);
    try { localStorage.setItem(LOG_KEY, JSON.stringify(lines)); } catch { /* ignore */ }
    renderLog();
  }
  function renderLog() {
    const el = $('log');
    el.innerHTML = lines.map((l) => `<div class="${l.c}">${l.s.replace(/</g, '&lt;')}</div>`).join('');
    el.scrollTop = el.scrollHeight;
  }
  renderLog();

  /* ---------------- UI setup ---------------- */
  $('ver').textContent = window.Extractor.version;
  for (const [key, c] of Object.entries(window.Extractor.clients())) {
    const o = document.createElement('option');
    o.value = key; o.textContent = c.label || key;
    $('client').appendChild(o);
  }
  const PREFS = ['link1', 'link2', 'engine', 'quality', 'client'];
  for (const k of PREFS) {
    const v = localStorage.getItem('hm_pref_' + k);
    if (v) $(k).value = v;
    $(k).addEventListener('change', () => localStorage.setItem('hm_pref_' + k, $(k).value));
  }
  $('custom').value = localStorage.getItem('hm_custom_clients') || '';

  const fmt = (s) => { s = Math.max(0, Math.floor(s || 0)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
  const opts = () => ({ client: $('client').value, quality: $('quality').value, log: (m) => log(m, 'warn') });

  /* ---------------- shared state ---------------- */
  let tracks = [];          // [{...extracted}, {...}]
  let currentIdx = 0;
  let engine = null;        // 'native' | 'html'
  let recovering = false;
  let lastTime = 0;

  function showTrack(t) {
    $('title').textContent = t ? t.title : '—';
    $('artist').textContent = t ? t.author : '';
    $('art').src = t ? t.thumbnail : '';
    $('info').textContent = t ? `${t.client} · ${t.itag} · ${t.kbps}k${t.sizeMB ? ' · ' + t.sizeMB + 'MB' : ''}` : '';
  }
  function showTime(cur, dur) {
    lastTime = cur;
    $('cur').textContent = fmt(cur);
    $('dur').textContent = fmt(dur);
    $('fill').style.width = dur > 0 ? `${Math.min(100, (cur / dur) * 100)}%` : '0';
  }
  function setState(s) { $('state').textContent = s; }

  async function extractTrack(input) {
    const t = await window.Extractor.extract(input, opts());
    const exp = t.expiresAt ? ` · صالح حتى ${new Date(t.expiresAt).toTimeString().slice(0, 5)}` : '';
    log(`✔ استخراج "${t.title}" عبر ${t.client} في ${t.timings.totalMs}ms — itag ${t.itag}, ${t.kbps}k${t.sizeMB ? ', ' + t.sizeMB + 'MB' : ''}${exp}`, 'ok');
    return t;
  }

  /* ---------------- extraction-only test ---------------- */
  $('test').addEventListener('click', async () => {
    const input = $('link1').value;
    log(`— اختبار الاستخراج (${$('client').value}, ${$('quality').value})`);
    try {
      const t = await extractTrack(input);
      log('الصيغ الصوتية المتاحة: ' + (t.formats.join(' | ') || 'HLS'));
    } catch (e) {
      log('✖ ' + e.message, 'bad');
    }
  });

  /* ---------------- start ---------------- */
  $('go').addEventListener('click', async () => {
    $('go').disabled = true;
    try {
      await stopAll();
      engine = $('engine').value;
      log(`— بدء: المشغّل ${engine}, ${$('client').value}, ${$('quality').value}`);
      tracks = [await extractTrack($('link1').value)];
      currentIdx = 0;
      showTrack(tracks[0]);
      if (engine === 'native') await nativeStart(tracks[0], 0);
      else await htmlStart(tracks[0], 0);
      if ($('link2').value.trim()) {
        try {
          const t2 = await extractTrack($('link2').value);
          tracks.push(t2);
          if (engine === 'native') {
            await NativePlayer.enqueue(nativeParams(t2, 0));
            log('التالية جاهزة في طابور المشغّل الأصلي', 'ok');
          } else {
            log('التالية جاهزة (ستُبدَّل قبل نهاية الأولى بنصف ثانية)', 'ok');
          }
        } catch (e) {
          log('✖ التالية: ' + e.message, 'bad');
        }
      }
    } catch (e) {
      log('✖ ' + e.message, 'bad');
      setState('خطأ');
    } finally {
      $('go').disabled = false;
    }
  });

  async function stopAll() {
    try { await NativePlayer.stop(); } catch { /* not started */ }
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
  }

  /* ---------------- recovery (network switch / expired link) ---------------- */
  async function recover(reason, atTime) {
    if (recovering || !tracks[currentIdx]) return;
    recovering = true;
    const t = tracks[currentIdx];
    log(`⚠️ ${reason} عند ${fmt(atTime)} — إعادة استخراج واستكمال…`, 'warn');
    try {
      const fresh = await window.Extractor.extract(t.id, opts());
      tracks[currentIdx] = fresh;
      if (engine === 'native') {
        await NativePlayer.start(nativeParams(fresh, atTime));
        const next = tracks[currentIdx + 1];
        if (next) await NativePlayer.enqueue(nativeParams(next, 0));
      } else {
        await htmlStart(fresh, atTime);
      }
      log(`✔ استُكمل التشغيل من ${fmt(atTime)}`, 'ok');
    } catch (e) {
      log('✖ فشل الاستكمال: ' + e.message, 'bad');
    } finally {
      setTimeout(() => { recovering = false; }, 3000);
    }
  }

  /* ================= NATIVE ENGINE ================= */
  function nativeParams(t, startAt) {
    return {
      url: t.url, id: t.id, title: t.title, artist: t.author, artwork: t.thumbnail,
      duration: t.duration, startAt, userAgent: localStorage.getItem('hm_send_ua') === '1' ? t.userAgent : '',
    };
  }
  async function nativeStart(t, startAt) {
    await NativePlayer.start(nativeParams(t, startAt));
    log(`▶ تشغيل أصلي: ${t.title}`);
  }

  if (Capacitor.isNativePlatform()) {
    NativePlayer.addListener('time', (e) => { if (engine === 'native') showTime(e.currentTime, e.duration); });
    NativePlayer.addListener('state', (e) => {
      if (engine !== 'native') return;
      const map = { playing: 'يعمل', paused: 'متوقف مؤقتًا', buffering: 'تحميل…' };
      setState(map[e.status] || e.status);
    });
    NativePlayer.addListener('itemChanged', (e) => {
      if (engine !== 'native') return;
      const idx = tracks.findIndex((t) => t.id === e.id);
      if (idx >= 0) {
        if (idx !== currentIdx) log(`⏭ انتقل تلقائيًا إلى: ${tracks[idx].title}`, 'ok', e.t);
        currentIdx = idx;
        showTrack(tracks[idx]);
      }
    });
    NativePlayer.addListener('ended', (e) => { if (engine === 'native') log(`■ انتهت: ${e.id}`, '', e.t); });
    NativePlayer.addListener('queueEnded', (e) => { if (engine === 'native') { log('■ انتهى الطابور', '', e.t); setState('انتهى'); } });
    NativePlayer.addListener('stalled', (e) => {
      if (engine !== 'native') return;
      log(`⚠️ توقف التدفق (stalled) عند ${fmt(e.currentTime)}`, 'warn', e.t);
      const at = e.currentTime;
      setTimeout(async () => {
        try {
          const s = await NativePlayer.getState();
          if (s.status !== 'playing' && Math.abs(s.currentTime - at) < 2) recover('لم يُستأنف بعد 8 ثوانٍ', at);
        } catch { /* ignore */ }
      }, 8000);
    });
    NativePlayer.addListener('error', (e) => {
      if (engine !== 'native') return;
      log(`✖ خطأ المشغّل (${e.code}): ${e.message}`, 'bad', e.t);
      if (e.isCurrent) recover('خطأ في التدفق', e.currentTime || lastTime);
    });
    NativePlayer.addListener('remote', (e) => log(`🔒 أمر من شاشة القفل: ${e.command}`));
  }

  /* ================= HTML ENGINE ================= */
  const audio = document.createElement('audio');
  audio.preload = 'auto';
  audio.setAttribute('playsinline', '');
  document.body.appendChild(audio);
  let switching = false;

  async function htmlStart(t, startAt) {
    audio.src = t.url;
    if (startAt > 0) {
      audio.addEventListener('loadedmetadata', () => { audio.currentTime = startAt; }, { once: true });
    }
    setMediaSession(t);
    await audio.play();
    log(`▶ تشغيل ويب: ${t.title}`);
  }

  function setMediaSession(t) {
    if (!('mediaSession' in navigator)) { log('⚠️ mediaSession غير مدعوم في هذا العارض', 'warn'); return; }
    navigator.mediaSession.metadata = new MediaMetadata({
      title: t.title, artist: t.author,
      artwork: [{ src: t.thumbnail, sizes: '480x360', type: 'image/jpeg' }],
    });
  }
  if ('mediaSession' in navigator) {
    const ms = navigator.mediaSession;
    const h = (a, f) => { try { ms.setActionHandler(a, f); } catch { /* unsupported */ } };
    h('play', () => audio.play());
    h('pause', () => audio.pause());
    h('nexttrack', () => { log('🔒 أمر من شاشة القفل: next'); htmlNext(); });
    h('previoustrack', () => { audio.currentTime = 0; });
    h('seekto', (d) => { audio.currentTime = d.seekTime; });
  }

  function htmlNext() {
    const next = tracks[currentIdx + 1];
    if (!next || switching) return;
    switching = true;
    currentIdx += 1;
    audio.src = next.url;           // same element, synchronous: best chance while locked
    audio.play().catch((e) => log('✖ play التالية: ' + e.message, 'bad'));
    setMediaSession(next);
    showTrack(next);
    log(`⏭ انتقل إلى: ${next.title}`, 'ok');
    setTimeout(() => { switching = false; }, 2000);
  }

  audio.addEventListener('timeupdate', () => {
    if (engine !== 'html') return;
    showTime(audio.currentTime, audio.duration || tracks[currentIdx]?.duration || 0);
    if (audio.duration && audio.duration - audio.currentTime <= 0.5) htmlNext();
  });
  audio.addEventListener('ended', () => { if (engine === 'html') { log('■ ended'); htmlNext(); } });
  audio.addEventListener('playing', () => engine === 'html' && setState('يعمل'));
  audio.addEventListener('pause', () => engine === 'html' && setState('متوقف مؤقتًا'));
  audio.addEventListener('waiting', () => engine === 'html' && setState('تحميل…'));
  audio.addEventListener('error', () => {
    if (engine !== 'html' || !audio.getAttribute('src')) return;
    const err = audio.error;
    log(`✖ خطأ audio (${err && err.code}): ${(err && err.message) || ''}`, 'bad');
    recover('خطأ في التدفق', lastTime);
  });

  /* ---------------- controls ---------------- */
  $('toggle').addEventListener('click', async () => {
    if (engine === 'native') {
      const s = await NativePlayer.getState();
      if (s.status === 'playing') await NativePlayer.pause(); else await NativePlayer.play();
    } else if (engine === 'html') {
      if (audio.paused) audio.play(); else audio.pause();
    }
  });
  $('next').addEventListener('click', async () => {
    if (engine === 'html') return htmlNext();
    if (engine === 'native') {
      const next = tracks[currentIdx + 1];
      if (next) { currentIdx += 1; showTrack(next); await NativePlayer.start(nativeParams(next, 0)); }
    }
  });
  $('prev').addEventListener('click', async () => {
    if (engine === 'native') await NativePlayer.seek({ seconds: 0 });
    else if (engine === 'html') audio.currentTime = 0;
  });
  $('bar').addEventListener('click', async (ev) => {
    const r = $('bar').getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width));
    const dur = engine === 'html' ? audio.duration : tracks[currentIdx]?.duration;
    if (!dur) return;
    if (engine === 'native') await NativePlayer.seek({ seconds: frac * dur });
    else audio.currentTime = frac * dur;
  });

  $('copy').addEventListener('click', async () => {
    const text = [
      `Music Test ${window.Extractor.version} · ${navigator.userAgent}`,
      ...lines.map((l) => l.s),
    ].join('\n');
    try { await navigator.clipboard.writeText(text); log('نُسخ السجل ✔', 'ok'); } catch {
      const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select();
      document.execCommand('copy'); ta.remove(); log('نُسخ السجل ✔', 'ok');
    }
  });
  $('clear').addEventListener('click', () => { lines = []; localStorage.removeItem(LOG_KEY); renderLog(); });

  $('saveCustom').addEventListener('click', () => {
    const v = $('custom').value.trim();
    if (!v) { localStorage.removeItem('hm_custom_clients'); log('أُزيلت الطرق المخصصة'); return; }
    try { JSON.parse(v); localStorage.setItem('hm_custom_clients', v); log('حُفظت الطرق المخصصة — أعد فتح التطبيق', 'ok'); } catch (e) { log('✖ JSON غير صالح: ' + e.message, 'bad'); }
  });
  $('resetCustom').addEventListener('click', () => { $('custom').value = ''; localStorage.removeItem('hm_custom_clients'); log('أُعيد الضبط — أعد فتح التطبيق'); });

  /* ---------------- background diagnostics ---------------- */
  document.addEventListener('visibilitychange', () => log(document.visibilityState === 'visible' ? '☀ عاد للواجهة' : '🌙 انتقل للخلفية / قُفلت الشاشة'));
  setInterval(() => { if (document.visibilityState !== 'visible') log('… JS ما زال يعمل في الخلفية'); }, 60000);

  if (!Capacitor.isNativePlatform()) log('⚠️ يعمل خارج التطبيق الأصلي: الاستخراج والمشغّل الأصلي لن يعملا هنا', 'warn');
  else log(`جاهز (${Capacitor.getPlatform()})`);
})();
