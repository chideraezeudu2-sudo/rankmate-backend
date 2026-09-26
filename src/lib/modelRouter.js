import Groq from 'groq-sdk';
import routerConfig from '../config/model-router.json' with { type: 'json' };

const groq = process.env.GROQ_API_KEY ? new Groq({ apiKey: process.env.GROQ_API_KEY }) : null;

/**
 * Runs one task through the model assigned to it in model-router.json.
 * Swap models by editing that config file, not by touching call sites.
 */
export async function runTask(taskName, { systemPrompt, userPrompt, jsonMode = false }) {
  const route = routerConfig[taskName];
  if (!route) throw new Error(`No model-router entry for task "${taskName}"`);

  if (route.provider === 'groq') {
    if (!groq) throw new Error('GROQ_API_KEY not set');
    const completion = await groq.chat.completions.create({
      model: route.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      response_format: jsonMode ? { type: 'json_object' } : undefined,
      temperature: 0.3,
    });
    return completion.choices[0].message.content;
  }

  if (route.provider === 'openai') {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: route.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      }),
    });
    const json = await res.json();
    return json.choices[0].message.content;
  }

  if (route.provider === 'anthropic') {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: route.model,
        max_tokens: 1024,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      }),
    });
    const json = await res.json();
    return json.content?.[0]?.text ?? '';
  }

  if (route.provider === 'perplexity') {
    const res = await fetch('https://api.perplexity.ai/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.PERPLEXITY_API_KEY}`,
      },
      body: JSON.stringify({
        model: route.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      }),
    });
    const json = await res.json();
    return json.choices[0].message.content;
  }

  throw new Error(`Unknown provider "${route.provider}" for task "${taskName}"`);
}
