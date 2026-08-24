/** Any OpenAI-compatible chat endpoint over raw fetch; env is read per call. */
export const brainReady = () =>
  Boolean(process.env.LLM_BASE_URL && process.env.LLM_MODEL);

/** One completion; throws on non-2xx, timeout, or an empty answer. */
export async function llm(system: string, user: string): Promise<string> {
  const { LLM_BASE_URL, LLM_API_KEY, LLM_MODEL } = process.env;
  const res = await fetch(`${LLM_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(LLM_API_KEY ? { authorization: `Bearer ${LLM_API_KEY}` } : {}),
    },
    body: JSON.stringify({
      model: LLM_MODEL,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      max_tokens: 300,
      temperature: 0.9,
    }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`llm ${res.status}`);
  const body = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  const text = body.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error('llm: empty answer');
  return text;
}
