export default {
  async fetch(request, env) {
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
    const url = new URL(request.url);
    if (url.pathname === '/health') return jr({ status: 'ok', service: 'clinic-os-server' }, 200, cors);
    if (request.method !== 'POST') return jr({ error: 'Method not allowed' }, 405, cors);
    const auth = request.headers.get('Authorization');
    if (!auth || auth !== `Bearer ${env.AUTH_TOKEN}`) return jr({ error: 'Unauthorized' }, 401, cors);
    try {
      if (url.pathname === '/chat') return await handleChat(request, env, cors);
      if (url.pathname === '/create') return await handleCreate(request, env, cors);
      if (url.pathname === '/query') return await handleQuery(request, env, cors);
      return jr({ error: 'Not found' }, 404, cors);
    } catch (err) {
      return jr({ error: err.message }, 500, cors);
    }
  }
};

// ═══════════════════════════════════════
// CHAT MODE — Natural language → Create entries
// ═══════════════════════════════════════
async function handleChat(request, env, cors) {
  const { message, database, history = [] } = await request.json();
  if (!message || !database) return jr({ error: 'Missing message or database' }, 400, cors);
  const msgs = [...history.map(h => ({ role: h.role, content: h.content })), { role: 'user', content: message }];
  const sys = buildPrompt(database);
  const resp = await callClaude(env.ANTHROPIC_API_KEY, sys, msgs);
  let text = resp.content?.map(b => b.type === 'text' ? b.text : '').join('') || '';
  let entries = [];
  try {
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (jsonMatch) entries = JSON.parse(jsonMatch[0]);
  } catch(e) {}
  let createdCount = 0;
  if (entries.length > 0) {
    for (const entry of entries) {
      const ok = await createNotionPage(env.NOTION_TOKEN, database, entry);
      if (ok) createdCount++;
    }
    text = text.replace(/\[[\s\S]*\]/, '').trim();
    if (!text) text = `Created ${createdCount} ${createdCount === 1 ? 'entry' : 'entries'} in ${database.name}.`;
  }
  return jr({ text, createdCount }, 200, cors);
}

// ═══════════════════════════════════════
// CSV/BULK MODE — Direct create from parsed rows
// ═══════════════════════════════════════
async function handleCreate(request, env, cors) {
  const { entries, database } = await request.json();
  if (!entries?.length || !database) return jr({ error: 'Missing entries or database' }, 400, cors);
  let ok = 0, fail = 0;
  for (const entry of entries) {
    const success = await createNotionPage(env.NOTION_TOKEN, database, entry);
    if (success) ok++; else fail++;
  }
  return jr({ text: `Created ${ok} of ${entries.length} entries.`, createdCount: ok, failed: fail }, 200, cors);
}

// ═══════════════════════════════════════
// QUERY MODE — Search across databases, AI summarizes
// ═══════════════════════════════════════
async function handleQuery(request, env, cors) {
  const { message, databases, history = [] } = await request.json();
  if (!message || !databases) return jr({ error: 'Missing message or databases' }, 400, cors);

  // Step 1: Ask Claude which databases to search and what filters to use
  const routingSys = buildRoutingPrompt(databases);
  const routingMsgs = [...history.map(h => ({ role: h.role, content: h.content })), { role: 'user', content: message }];
  const routingResp = await callClaude(env.ANTHROPIC_API_KEY, routingSys, routingMsgs);
  const routingText = routingResp.content?.map(b => b.type === 'text' ? b.text : '').join('') || '';

  // Step 2: Parse Claude's routing decision
  let searchPlan;
  try {
    const jsonMatch = routingText.match(/\{[\s\S]*\}/);
    if (jsonMatch) searchPlan = JSON.parse(jsonMatch[0]);
  } catch(e) {}

  if (!searchPlan || !searchPlan.searches) {
    return jr({ text: routingText, results: [] }, 200, cors);
  }

  // Step 3: Execute Notion database queries
  const allResults = [];
  for (const search of searchPlan.searches) {
    const db = databases.find(d => d.ds === search.database_id);
    if (!db) continue;
    const pages = await queryNotionDatabase(env.NOTION_TOKEN, search.database_id, search.filter || undefined, search.sorts || undefined);
    if (pages.length > 0) {
      allResults.push({
        database: db.name,
        count: pages.length,
        entries: pages.map(p => extractPageProperties(p, db))
      });
    }
  }

  // Step 4: Send results to Claude for a conversational summary
  const summarySys = `You are a helpful clinic assistant. The user asked a question and we queried the clinic's Notion databases. Summarize the results conversationally. Be specific with names, numbers, and details. If no results were found, say so helpfully. Keep it concise but complete.`;
  const summaryMsgs = [
    { role: 'user', content: `Original question: "${message}"\n\nDatabase results:\n${JSON.stringify(allResults, null, 2)}\n\nPlease summarize these results for the user in a helpful, conversational way.` }
  ];
  const summaryResp = await callClaude(env.ANTHROPIC_API_KEY, summarySys, summaryMsgs);
  const summaryText = summaryResp.content?.map(b => b.type === 'text' ? b.text : '').join('') || 'No results found.';

  return jr({ text: summaryText, results: allResults, searchPlan }, 200, cors);
}

// ═══════════════════════════════════════
// NOTION API HELPERS
// ═══════════════════════════════════════
async function createNotionPage(token, database, entry) {
  const properties = {};
  for (const field of database.fields) {
    const val = entry[field.n];
    if (val === undefined || val === null || String(val).trim() === '') continue;
    switch (field.t) {
      case 'title':
        properties[field.n] = { title: [{ text: { content: String(val) } }] };
        break;
      case 'text':
        properties[field.n] = { rich_text: [{ text: { content: String(val) } }] };
        break;
      case 'number':
        properties[field.n] = { number: parseFloat(val) || 0 };
        break;
      case 'select':
        properties[field.n] = { select: { name: String(val) } };
        break;
      case 'multi_select':
        const items = String(val).split(',').map(s => ({ name: s.trim() }));
        properties[field.n] = { multi_select: items };
        break;
      case 'url':
        properties[field.n] = { url: String(val) };
        break;
    }
  }
  try {
    const r = await fetch('https://api.notion.com/v1/pages', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Notion-Version': '2022-06-28'
      },
      body: JSON.stringify({
        parent: { database_id: database.ds },
        properties: properties
      })
    });
    if (!r.ok) { console.error('Notion error:', await r.text()); return false; }
    return true;
  } catch (err) { console.error('Notion fetch error:', err); return false; }
}

async function queryNotionDatabase(token, databaseId, filter, sorts) {
  const body = { page_size: 100 };
  if (filter) body.filter = filter;
  if (sorts) body.sorts = sorts;
  try {
    const r = await fetch(`https://api.notion.com/v1/databases/${databaseId}/query`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Notion-Version': '2022-06-28'
      },
      body: JSON.stringify(body)
    });
    if (!r.ok) { console.error('Notion query error:', await r.text()); return []; }
    const data = await r.json();
    return data.results || [];
  } catch (err) { console.error('Notion query fetch error:', err); return []; }
}

function extractPageProperties(page, db) {
  const result = {};
  for (const field of db.fields) {
    const prop = page.properties?.[field.n];
    if (!prop) continue;
    switch (prop.type) {
      case 'title':
        result[field.n] = prop.title?.map(t => t.plain_text).join('') || '';
        break;
      case 'rich_text':
        result[field.n] = prop.rich_text?.map(t => t.plain_text).join('') || '';
        break;
      case 'number':
        result[field.n] = prop.number;
        break;
      case 'select':
        result[field.n] = prop.select?.name || '';
        break;
      case 'multi_select':
        result[field.n] = prop.multi_select?.map(s => s.name).join(', ') || '';
        break;
      case 'url':
        result[field.n] = prop.url || '';
        break;
      case 'date':
        result[field.n] = prop.date?.start || '';
        break;
      case 'checkbox':
        result[field.n] = prop.checkbox ? 'Yes' : 'No';
        break;
      case 'people':
        result[field.n] = prop.people?.map(p => p.name).join(', ') || '';
        break;
      case 'status':
        result[field.n] = prop.status?.name || '';
        break;
      default:
        result[field.n] = '[unsupported type]';
    }
  }
  return result;
}

// ═══════════════════════════════════════
// CLAUDE API
// ═══════════════════════════════════════
async function callClaude(apiKey, system, messages) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4000,
      system: system,
      messages: messages
    })
  });
  if (!r.ok) throw new Error(`Claude API ${r.status}: ${await r.text()}`);
  return await r.json();
}

// ═══════════════════════════════════════
// PROMPT BUILDERS
// ═══════════════════════════════════════
function buildPrompt(db) {
  return `You are a data entry assistant for a physical therapy clinic. Parse user input into structured entries for the "${db.name}" database.

FIELDS:
${db.fields.map(f => `- "${f.n}" (${f.t})${f.o ? ': options=[' + f.o.join(', ') + ']' : ''}${f.r ? ' [REQUIRED]' : ''}`).join('\n')}

INSTRUCTIONS:
1. Parse the user's natural language into one or more entries
2. Return a JSON array of objects where keys are field names and values are the parsed data
3. For select fields, use the closest matching option from the list
4. For numbers, use numeric values only (no $ signs)
5. After the JSON array, add a brief confirmation message
6. If something is unclear, make your best guess from context

Example response format:
[{"Field Name": "value", "Other Field": "value"}]
Created 1 entry: Item Name here.`;
}

function buildRoutingPrompt(databases) {
  const dbList = databases.map(db => {
    const fields = db.fields.map(f => {
      let desc = `"${f.n}" (${f.t})`;
      if (f.o) desc += ` options=[${f.o.join(', ')}]`;
      return desc;
    }).join(', ');
    return `- "${db.name}" [id: ${db.ds}]: Fields: ${fields}`;
  }).join('\n');

  return `You are a clinic database query router. Given a user's question, decide which database(s) to search and what filters to apply.

AVAILABLE DATABASES:
${dbList}

INSTRUCTIONS:
1. Analyze the user's question to determine which database(s) to query
2. Return a JSON object with a "searches" array. Each search has:
   - "database_id": the database ID to query
   - "filter": optional Notion filter object (use Notion API filter syntax)
   - "sorts": optional Notion sorts array
3. For broad questions ("show me everything", "what do we have"), query without filters
4. For specific questions ("bike parts over $150"), add appropriate filters
5. You can search multiple databases if the question spans them

NOTION FILTER SYNTAX EXAMPLES:
- Text contains: {"property":"Name","rich_text":{"contains":"saddle"}}
- Number greater than: {"property":"Cost","number":{"greater_than":150}}
- Select equals: {"property":"Category","select":{"equals":"Saddles"}}
- Combine with "and": {"and":[filter1, filter2]}

Return ONLY the JSON object, no other text.

Example response:
{"searches":[{"database_id":"abc123","filter":{"property":"Cost","number":{"greater_than":150}}}]}`;
}

function jr(data, status, cors) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...cors } });
}
