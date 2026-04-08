// Rate limiter: 20 Claude requests per IP per hour
const rateLimitMap = new Map();
const LIMIT = 20;
const WINDOW_MS = 60 * 60 * 1000;

function isRateLimited(ip) {
  const now = Date.now();
  const entry = rateLimitMap.get(ip) || { count: 0, resetAt: now + WINDOW_MS };
  if (now > entry.resetAt) { entry.count = 0; entry.resetAt = now + WINDOW_MS; }
  entry.count++;
  rateLimitMap.set(ip, entry);
  return entry.count > LIMIT;
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: 'Method not allowed' };

  const ip = (event.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  if (isRateLimited(ip)) {
    return {
      statusCode: 429,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Too many requests — please wait a while before trying again.' }),
    };
  }

  const KEY = process.env.ANTHROPIC_API_KEY;
  if (!KEY) {
    return {
      statusCode: 500,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Service not configured.' }),
    };
  }

  // Parse body — handle both string and object
  let body;
  try {
    body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
  } catch (e) {
    return {
      statusCode: 400,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Invalid JSON: ' + e.message }),
    };
  }

  if (!body || typeof body !== 'object') {
    return {
      statusCode: 400,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Empty or invalid request body.' }),
    };
  }

  const task = body.task;
  let prompt;

  if (task === 'suggest') {
    const typeLabel = body.typeLabel || 'movies and TV shows';
    const moodLabel = body.moodLabel || '';
    const eraLabel  = body.eraLabel  || '';
    const custom    = body.custom    || '';
    const customNote = custom ? ` Additional preference: "${custom}".` : '';
    prompt = `Suggest 6 ${typeLabel}${moodLabel}${eraLabel} that are perfect to watch with mom — family-friendly, no graphic violence or explicit content.${customNote}

Return ONLY a JSON array of 6 objects:
- title (string, exact title)
- year (string, e.g. "2019" or "2020-2023")
- type ("Movie" or "TV Show")
- why (1-2 warm sentences explaining why it's perfect for mom)
- tags (array of 2-3 short genre/mood tags)

Raw JSON only, no markdown.`;

  } else if (task === 'analyze') {
    const title    = body.title    || 'Unknown';
    const synopsis = body.synopsis || 'No synopsis available.';
    const rating   = body.rating   || 'unrated';
    const genre    = body.genre    || 'unknown genre';
    const cast     = Array.isArray(body.cast) && body.cast.length ? body.cast.join(', ') : '';

    prompt = `You are a helpful family movie advisor. Analyze "${title}" (${genre}, rated ${rating}) for watching with mom.

Known details: ${synopsis}${cast ? ` Starring: ${cast}.` : ''}

Return ONLY this JSON object:
{
  "mom_stars": 4,
  "mom_verdict": "witty 1-sentence verdict on watching this with mom",
  "racy_items": [
    {
      "headline": "funny catchy short headline about a content concern",
      "detail": "factual 1-2 sentence description of the actual content",
      "severity": "low or medium or high"
    }
  ]
}

Rules:
- mom_stars: 5 = G-rated family bliss, 4 = a few mild moments, 3 = some things to note, 2 = mom might squirm, 1 = watch alone first
- racy_items: only include medium or high severity items notable for a mom audience. If genuinely clean return empty array.
- Be witty in headlines but factual in details.

Raw JSON only, no markdown.`;

  } else {
    return {
      statusCode: 400,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Unknown task: ' + task }),
    };
  }

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: task === 'suggest' ? 1200 : 800,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    const data = await res.json();

    if (!res.ok) {
      return {
        statusCode: res.status,
        headers: { ...CORS, 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: data && data.error ? data.error.message : 'AI error.' }),
      };
    }

    return {
      statusCode: 200,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message }),
    };
  }
};
