// api/logWorkout.js
export default async function handler(req, res) {
    if (req.method !== 'POST') {
      return res.status(405).json({ success: false, message: 'Method Not Allowed' });
    }
  
    // 認証（X-Webhook-Secret でも Authorization: Bearer でも可）
    const secret = process.env.WEBHOOK_SECRET;
    const auth = req.headers['authorization'] || '';
    const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : null;
    const provided = req.headers['x-webhook-secret'] || bearer;
    if (secret && provided !== secret) {
      return res.status(401).json({ success: false, message: 'Unauthorized (Invalid Secret)' });
    }
  
    // Notion 環境
    const notionToken = process.env.NOTION_TOKEN;
    const DB_LOG  = process.env.NOTION_DATABASE_ID_LOG;
    const DB_SETS = process.env.NOTION_DATABASE_ID_SETS;
    if (!notionToken || !DB_LOG) {
      return res.status(500).json({ success: false, message: 'Server misconfig (NOTION_TOKEN/DB_LOG)' });
    }

    console.log("NOTION_TOKEN:", notionToken ? "set" : "missing");
    console.log("DB_LOG:", DB_LOG);
    console.log("DB_SETS:", DB_SETS);
  
    // JSON 受信
    let body = {};
    try {
      body = typeof req.body === 'object' && req.body ? req.body
        : JSON.parse(Buffer.concat(await (async function*(){for await (const c of req) yield c})()).toString() || '{}');
    } catch {
      return res.status(400).json({ success: false, message: 'Bad JSON' });
    }
  
    const { title, date, type, bodyPart, memo, sets, run } = body || {};
    if (!title || !date || !type) {
      return res.status(400).json({ success: false, message: 'Missing fields (title/date/type)' });
    }
  
    // --- Body Part 正規化（日本語カテゴリ）
    const mapJP = {
      '胸':'胸','肩':'肩','腕':'腕','背中':'背中','脚':'脚','足':'脚','腹':'腹','体幹':'腹',
      'chest':'胸','pec':'胸','pecs':'胸',
      'shoulder':'肩','shoulders':'肩','delts':'肩',
      'arm':'腕','arms':'腕','biceps':'腕','triceps':'腕','forearm':'腕','forearms':'腕',
      'back':'背中','lats':'背中',
      'legs':'脚','leg':'脚','quads':'脚','hamstrings':'脚','calves':'脚','glutes':'脚',
      'core':'腹','abs':'腹','abdominals':'腹'
    };
    function normalizeBodyParts(input) {
      if (!input) return [];
      const raw = Array.isArray(input) ? input : String(input).split(/[,/／｜|、\s]+/);
      const out = new Set();
      for (const r of raw) {
        const key = String(r || '').toLowerCase().trim();
        if (!key) continue;
        if (mapJP[key]) out.add(mapJP[key]);
      }
      return Array.from(out);
    }
  
    // Type 正規化
    const normType = (() => {
      const t = String(type || '').toLowerCase();
      if (t.includes('run')) return 'Run';
      if (t.includes('strength') || t.includes('gym') || t.includes('lift') || t.includes('筋')) return 'Strength';
      return type;
    })();
  
    // Run のときは Body Part = 「無し」
    const bpArr = normType === 'Run' ? ['無し'] : normalizeBodyParts(bodyPart);
  
    // Notion 呼び出し
    async function notion(path, init) {
      return fetch(`https://api.notion.com/v1/${path}`, {
        ...init,
        headers: {
          'Authorization': `Bearer ${notionToken}`,
          'Notion-Version': '2022-06-28',
          'Content-Type': 'application/json',
          ...(init?.headers || {})
        }
      });
    }
    console.log("NOTION_TOKEN:", notionToken ? "set" : "missing");
    console.log("DB_LOG:", DB_LOG);
    console.log("DB_SETS:", DB_SETS);
    

  
    try {
      // 1) Training Log 作成
      const logProps = {
        parent: { database_id: DB_LOG },
        properties: {
          'Session Title': { title: [{ text: { content: title } }] },
          'Date': { date: { start: date } },
          'Type': { select: { name: normType } },
          ...(bpArr.length ? { 'Body Part': { multi_select: bpArr.map(name => ({ name })) } } : {}),
          ...(memo ? { 'Memo': { rich_text: [{ text: { content: memo } }] } } : {})
        }
      };
      const createLog = await notion('pages', { method: 'POST', body: JSON.stringify(logProps) });
      if (!createLog.ok) {
        const t = await createLog.text();
        return res.status(500).json({ success: false, message: 'Notion(Create Session) error', error: t });
      }
      const logJson = await createLog.json();
      const sessionId = logJson.id;
  
      // 2) Training Sets への登録
      let setsCreated = 0;
      if (DB_SETS) {
        if (normType === 'Run' && run && (run.distance_km || run.time_min || run.start_time)) {
          const startLabelRun = (typeof run?.start_time === 'string' && run.start_time.trim()) ? run.start_time.trim() : null;
          // 有酸素運動
          const propsRun = {
            parent: { database_id: DB_SETS },
            properties: {
              'Session':   { relation: [{ id: sessionId }] },
              'Exercise':  { title: [{ text: { content: '有酸素運動' } }] },
              ...(Number.isFinite(run.distance_km) ? { 'Distance': { number: run.distance_km } } : {}),
              ...(Number.isFinite(run.time_min)    ? { 'Time':     { number: run.time_min } }    : {}),
              ...(startLabelRun ? { 'Start Time': { select: { name: startLabelRun } } } : {})
            }
          };
          const r = await notion('pages', { method: 'POST', body: JSON.stringify(propsRun) });
          if (!r.ok) return res.status(500).json({ success: false, message: 'Notion(Create Run Set) error', error: await r.text() });
          setsCreated += 1;
        }
  
        if (normType === 'Strength' && Array.isArray(sets) && sets.length) {
          // 同一種目に連番を付ける（ベンチプレス1, ベンチプレス2…）
          const counters = Object.create(null);
          for (const s of sets) {
            const base = s?.exercise ? String(s.exercise).trim() : '';
            if (!base) continue;
            counters[base] = (counters[base] || 0) + 1;
            const label = `${base}${counters[base]}`; // 1始まりの連番
            const propsStrength = {
              parent: { database_id: DB_SETS },
              properties: {
                'Session':  { relation: [{ id: sessionId }] },
                'Exercise': { title: [{ text: { content: label } }] },
                ...(Number.isFinite(s?.weight) ? { 'Weight': { number: s.weight } } : {}),
                ...(Number.isFinite(s?.reps)   ? { 'Reps':   { number: s.reps } }   : {}),
                ...(Number.isFinite(s?.sets)   ? { 'Sets':   { number: s.sets } }   : {})
              }
            };
            const r = await notion('pages', { method: 'POST', body: JSON.stringify(propsStrength) });
            if (!r.ok) return res.status(500).json({ success: false, message: 'Notion(Create Strength Set) error', error: await r.text() });
            setsCreated += 1;
          }
        }
      }
  
      return res.status(200).json({
        success: true,
        message: 'Workout logged successfully',
        session_page_id: sessionId,
        sets_created: setsCreated
      });
    } catch (e) {
      return res.status(500).json({ success: false, message: 'Server error', error: String(e) });
    }
  }

  // Notion 呼び出し
async function notion(path, init) {
  return fetch(`https://api.notion.com/v1/${path}`, {
    ...init,
    headers: {
      'Authorization': `Bearer ${notionToken}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json',
      ...(init?.headers || {})
    }
  });
}
