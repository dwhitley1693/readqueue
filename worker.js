/**
 * ReadQueue Cloudflare Worker
 * Receives a URL + optional title, auto-tags with Claude,
 * writes to Google Sheet via Service Account or API key.
 *
 * Environment variables to set in Cloudflare dashboard:
 *   ANTHROPIC_KEY   - your Anthropic API key (sk-ant-...)
 *   GOOGLE_KEY      - your Google Sheets API key (AIza...)
 *   SHEET_ID        - your Google Sheet ID
 *   WORKER_SECRET   - a random secret string you choose (protects the endpoint)
 */

const SHEET_NAME = 'Items';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Worker-Secret',
};

export default {
  async fetch(request, env) {
    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    if (request.method !== 'POST') {
      return json({ error: 'POST only' }, 405);
    }

    // Auth check
    const secret = request.headers.get('X-Worker-Secret');
    if (env.WORKER_SECRET && secret !== env.WORKER_SECRET) {
      return json({ error: 'Unauthorized' }, 401);
    }

    let body;
    try { body = await request.json(); }
    catch(e) { return json({ error: 'Invalid JSON' }, 400); }

    const { url, title: rawTitle } = body;
    if (!url) return json({ error: 'url required' }, 400);

    // 1. Auto-tag with Claude
    let title = rawTitle || url;
    let desc = '';
    let type = 'article';
    let tags = [];
    let time = null;

    try {
      const aiResp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': env.ANTHROPIC_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 400,
          messages: [{
            role: 'user',
            content: `Analyze this URL and return ONLY valid JSON (no markdown, no explanation):
URL: ${url}
TITLE HINT: ${rawTitle || 'none'}
{"title":"concise title","desc":"2-sentence description of content and why it matters","type":"article|podcast|video|pdf|substack|journal|other","tags":["tag1","tag2"],"time":estimated_minutes_integer}
type: youtube/vimeo=video, spotify/podcast in URL=podcast, substack.com=substack, arxiv/pubmed=journal.
tags: 2-5 from: finance AI economics technology health politics science history philosophy business investing culture psychology environment`
          }]
        })
      });
      const aiData = await aiResp.json();
      if (!aiData.error) {
        const parsed = JSON.parse(aiData.content[0].text.replace(/```json|```/g, '').trim());
        title   = parsed.title  || title;
        desc    = parsed.desc   || '';
        type    = parsed.type   || 'article';
        tags    = parsed.tags   || [];
        time    = parsed.time   || null;
      }
    } catch(e) {
      // AI failed — continue with basic metadata
      console.error('AI tagging failed:', e.message);
    }

    // 2. Write to Google Sheet
    const now = Date.now();
    const id  = now.toString(36) + Math.random().toString(36).slice(2, 6);
    const row = [
      id, 'me', url, title, desc, type, 'medium',
      time || '', '', 'unreviewed',
      tags.join(', '), now, now,
      '', '', '', '' // takeaways + lists
    ];

    const range = encodeURIComponent(`${SHEET_NAME}!A:Q`);
    const sheetResp = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${env.SHEET_ID}/values/${range}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS&key=${env.GOOGLE_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ values: [row] })
      }
    );

    if (!sheetResp.ok) {
      const errText = await sheetResp.text();
      return json({ error: 'Sheet write failed', detail: errText }, 500);
    }

    return json({
      success: true,
      id,
      title,
      desc,
      type,
      tags,
      time,
      message: `"${title}" added to ReadQueue`
    });
  }
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' }
  });
}
