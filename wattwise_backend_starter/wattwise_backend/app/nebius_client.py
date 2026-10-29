"""Optional Nebius / NVIDIA Token client. AI explains calculations; it never computes them."""
import os, json, httpx

BASE_URL = os.getenv('NEBIUS_BASE_URL', 'https://api.tokenfactory.nebius.com/v1/').rstrip('/') + '/'
MODEL = os.getenv('NEBIUS_MODEL', 'nvidia/nemotron-3.5-lightning-30b-a3b')

async def explain_analysis(result: dict) -> str:
    key = os.getenv('NEBIUS_API_KEY')
    if not key:
        raise RuntimeError('NEBIUS_API_KEY is not configured on the backend.')
    system = (
        'You are WattWise, an industrial energy analyst. Explain only supplied results. '
        'Do not invent or alter numbers. Call unusual consumption a potential anomaly, not confirmed waste. '
        'Separate measured values from estimates and projections. Give a concise summary, '
        'three evidence-based investigation steps, and data-quality caveats.'
    )
    payload = {
        'model': MODEL,
        'temperature': 0.2,
        'max_tokens': 1500,
        'chat_template_kwargs': {'enable_thinking': False},
        'messages': [
            {'role': 'system', 'content': system},
            {'role': 'user', 'content': 'Explain these calculated WattWise results:\n' + json.dumps(result)}
        ]
    }
    async with httpx.AsyncClient(timeout=httpx.Timeout(60.0, connect=10.0)) as client:
        response = await client.post(
            BASE_URL + 'chat/completions',
            headers={'Authorization': f'Bearer {key}', 'Content-Type': 'application/json'},
            json=payload
        )
        response.raise_for_status()
        data = response.json()
    choice = data['choices'][0]['message']
    return choice.get('content') or choice.get('reasoning_content') or ''
