// YouTube audio extractor that runs ON THE PHONE (home / mobile IP, so YouTube does not block it).
// Requests go through Capacitor's native HTTP (no CORS). Mirrors yt-dlp's JS-free "visionos" client,
// which needs no PO token and no signature deciphering. Client definitions can be overridden from
// the app's settings without rebuilding (see CLIENTS / custom JSON).
(function () {
  'use strict';
  const { CapacitorHttp } = window.capacitorExports;

  const WEB_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';

  // Copied from yt-dlp 2026.10.26 (extractor/youtube/_base.py)
  const CLIENTS = {
    visionos: {
      label: 'visionOS (بدون PO token)',
      nameId: 101,
      context: {
        clientName: 'VISIONOS', clientVersion: '1.02', deviceMake: 'Apple', deviceModel: 'RealityDevice17,1',
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_7_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15',
        osName: 'visionOS', osVersion: '26.5.23O471',
      },
    },
    ios: {
      label: 'iOS (HLS صوت فقط)',
      nameId: 5,
      hls: true,
      context: {
        clientName: 'IOS', clientVersion: '21.26.4', deviceMake: 'Apple', deviceModel: 'iPhone16,2',
        userAgent: 'com.google.ios.youtube/21.26.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)',
        osName: 'iPhone', osVersion: '18.3.2.22D82',
      },
    },
    android_vr: {
      label: 'Android VR',
      nameId: 28,
      context: {
        clientName: 'ANDROID_VR', clientVersion: '1.65.10', deviceMake: 'Oculus', deviceModel: 'Quest 3',
        androidSdkVersion: 32, osName: 'Android', osVersion: '12L',
        userAgent: 'com.google.android.apps.youtube.vr.oculus/1.65.10 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip',
      },
    },
  };

  function clients() {
    try {
      const custom = JSON.parse(localStorage.getItem('hm_custom_clients') || 'null');
      if (custom && typeof custom === 'object') return { ...CLIENTS, ...custom };
    } catch { /* ignore bad JSON */ }
    return CLIENTS;
  }

  function parseVideoId(input) {
    const s = String(input || '').trim();
    if (/^[A-Za-z0-9_-]{11}$/.test(s)) return s;
    try {
      const u = new URL(s.startsWith('http') ? s : 'https://' + s);
      if (u.hostname.endsWith('youtu.be')) return u.pathname.slice(1, 12);
      if (u.searchParams.get('v')) return u.searchParams.get('v').slice(0, 11);
      const m = u.pathname.match(/\/(?:shorts|embed|live|v)\/([A-Za-z0-9_-]{11})/);
      if (m) return m[1];
    } catch { /* not a URL */ }
    const m = s.match(/([A-Za-z0-9_-]{11})/);
    return m ? m[1] : null;
  }

  async function http(opts) {
    const t0 = Date.now();
    const res = await CapacitorHttp.request({ connectTimeout: 15000, readTimeout: 20000, ...opts });
    return { ...res, ms: Date.now() - t0 };
  }

  // visitorData = anonymous session id YouTube expects; cached for 6 hours
  async function getVisitorData(videoId, force) {
    const cached = JSON.parse(localStorage.getItem('hm_visitor') || 'null');
    if (!force && cached && Date.now() - cached.t < 6 * 3600e3) return cached.v;
    const res = await http({
      method: 'GET',
      url: `https://www.youtube.com/watch?v=${videoId}&bpctr=9999999999&has_verified=1`,
      headers: { 'User-Agent': WEB_UA, 'Accept-Language': 'en-US,en;q=0.9' },
      responseType: 'text',
    });
    const html = typeof res.data === 'string' ? res.data : '';
    const m = html.match(/"VISITOR_DATA"\s*:\s*"([^"]+)"/) || html.match(/"visitorData"\s*:\s*"([^"]+)"/);
    if (!m) throw new Error(`visitorData not found (HTTP ${res.status})`);
    localStorage.setItem('hm_visitor', JSON.stringify({ v: m[1], t: Date.now() }));
    return m[1];
  }

  async function playerRequest(videoId, clientKey, visitorData) {
    const c = clients()[clientKey];
    if (!c) throw new Error('unknown client ' + clientKey);
    const res = await http({
      method: 'POST',
      url: 'https://www.youtube.com/youtubei/v1/player?prettyPrint=false',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': c.context.userAgent,
        'X-YouTube-Client-Name': String(c.nameId),
        'X-YouTube-Client-Version': c.context.clientVersion,
        'X-Goog-Visitor-Id': visitorData || '',
        Origin: 'https://www.youtube.com',
      },
      data: {
        context: { client: { hl: 'en', gl: 'US', ...c.context, ...(visitorData ? { visitorData } : {}) } },
        videoId,
        playbackContext: { contentPlaybackContext: { html5Preference: 'HTML5_PREF_WANTS' } },
        contentCheckOk: true,
        racyCheckOk: true,
      },
    });
    let data = res.data;
    if (typeof data === 'string') { try { data = JSON.parse(data); } catch { data = null; } }
    if (!data || typeof data !== 'object') throw new Error(`player API HTTP ${res.status}: unexpected response`);
    return { data, ms: res.ms, status: res.status };
  }

  // Pick an audio-only stream. quality: 'low' (~48 kbps) | 'normal' (~128 kbps)
  function pickFormat(formats, quality) {
    const audio = (formats || []).filter((f) => f.url && /^audio\/mp4/.test(f.mimeType || ''));
    if (!audio.length) return null;
    const byItag = (i) => audio.find((f) => f.itag === i);
    if (quality === 'low') return byItag(139) || audio.slice().sort((a, b) => a.bitrate - b.bitrate)[0];
    return byItag(140) || audio.slice().sort((a, b) => b.bitrate - a.bitrate)[0];
  }

  // iOS client: audio-only HLS rendition from the master playlist (233 = low, 234 = high)
  async function pickHls(masterUrl, quality) {
    const res = await http({ method: 'GET', url: masterUrl, responseType: 'text' });
    const text = typeof res.data === 'string' ? res.data : '';
    const medias = [...text.matchAll(/#EXT-X-MEDIA:([^\n]+)/g)]
      .map((m) => m[1])
      .filter((l) => /TYPE=AUDIO/.test(l))
      .map((l) => ({ group: (l.match(/GROUP-ID="([^"]+)"/) || [])[1], uri: (l.match(/URI="([^"]+)"/) || [])[1], line: l }))
      .filter((m) => m.uri);
    if (!medias.length) return null;
    const want = quality === 'low' ? '233' : '234';
    return medias.find((m) => m.group === want) || medias[quality === 'low' ? 0 : medias.length - 1];
  }

  /**
   * Returns { url, client, itag, mime, kbps, sizeMB, title, author, thumbnail, duration, expiresAt, timings, formats }
   */
  async function extract(input, { client = 'visionos', quality = 'normal', log = () => {} } = {}) {
    const videoId = parseVideoId(input);
    if (!videoId) throw new Error('رابط يوتيوب غير صالح');
    const c = clients()[client];
    if (!c) throw new Error('unknown client ' + client);

    const t0 = Date.now();
    let visitor = null;
    try { visitor = await getVisitorData(videoId); } catch (e) { log('⚠️ visitorData: ' + e.message); }

    let { data, ms } = await playerRequest(videoId, client, visitor);
    let status = data.playabilityStatus?.status;
    if (status !== 'OK') {
      log(`⚠️ ${client}: ${status} — ${data.playabilityStatus?.reason || ''}. إعادة المحاولة بجلسة جديدة…`);
      try { visitor = await getVisitorData(videoId, true); } catch (e) { log('⚠️ visitorData: ' + e.message); }
      ({ data, ms } = await playerRequest(videoId, client, visitor));
      status = data.playabilityStatus?.status;
    }
    if (status !== 'OK') {
      const reason = data.playabilityStatus?.reason || data.playabilityStatus?.messages?.join(' ') || 'unknown';
      throw new Error(`${client}: ${status} — ${reason}`);
    }

    const sd = data.streamingData || {};
    const vd = data.videoDetails || {};
    const formats = (sd.adaptiveFormats || []).filter((f) => /^audio/.test(f.mimeType || ''))
      .map((f) => `${f.itag} ${String(f.mimeType).split(';')[0]} ${Math.round((f.bitrate || 0) / 1000)}k ${f.url ? 'url' : (f.signatureCipher ? 'CIPHER' : 'no-url')}`);

    let out;
    if (c.hls) {
      if (!sd.hlsManifestUrl) throw new Error(`${client}: no HLS manifest`);
      const m = await pickHls(sd.hlsManifestUrl, quality);
      if (!m) throw new Error(`${client}: no audio-only HLS rendition`);
      out = { url: m.uri, itag: 'hls-' + m.group, mime: 'application/x-mpegURL', kbps: m.group === '233' ? 48 : 128, sizeMB: null };
    } else {
      const f = pickFormat(sd.adaptiveFormats, quality);
      if (!f) throw new Error(`${client}: no direct audio/mp4 URL (formats: ${formats.join(' | ') || 'none'})`);
      out = {
        url: f.url, itag: f.itag, mime: f.mimeType, kbps: Math.round((f.bitrate || 0) / 1000),
        sizeMB: f.contentLength ? +(f.contentLength / 1048576).toFixed(2) : null,
      };
    }

    let expiresAt = null;
    try { expiresAt = +new URL(out.url).searchParams.get('expire') * 1000 || null; } catch { /* ignore */ }

    return {
      ...out,
      id: videoId,
      client,
      userAgent: c.context.userAgent,
      title: vd.title || videoId,
      author: (vd.author || '').replace(/ - Topic$/, ''),
      thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
      duration: +vd.lengthSeconds || 0,
      expiresAt,
      timings: { totalMs: Date.now() - t0, playerMs: ms },
      formats,
    };
  }

  window.Extractor = { extract, parseVideoId, clients, CLIENTS, version: '2026.11.08-1' };
})();
