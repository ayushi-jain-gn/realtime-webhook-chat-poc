// POC desktop consumer: run this in Electron main/renderer or Node 18+
// to subscribe to live processed message events.

const baseUrl = process.env.BASE_URL || 'http://localhost:8080';
const token = process.env.WEBHOOK_TOKEN || '';

async function run() {
  const headers = {};
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(`${baseUrl}/stream`, { headers });
  if (!response.ok || !response.body) {
    throw new Error(`Failed to connect to stream: ${response.status}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split('\n\n');
    buffer = chunks.pop() || '';

    for (const chunk of chunks) {
      const lines = chunk.split('\n');
      const dataLine = lines.find((line) => line.startsWith('data: '));
      if (!dataLine) continue;

      const data = JSON.parse(dataLine.slice('data: '.length));
      console.log(`[desktop] ${data.direction.toUpperCase()} ${data.id}: ${data.text}`);
    }
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
