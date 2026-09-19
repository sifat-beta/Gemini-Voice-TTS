export default async function handler(req, res) {
  // Only accept POST requests
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    const { text, voice = 'Puck', apiKey: clientKey } = req.body;

    if (!text || !text.trim()) {
      return res.status(400).json({ error: 'Text prompt cannot be empty.' });
    }

    // Prioritize user-entered key from UI, fallback to Vercel env variable
    const apiKey = clientKey?.trim() || process.env.GEMINI_API_KEY;

    if (!apiKey) {
      return res.status(401).json({
        error: 'No API key provided. Please enter your Gemini API key in the studio settings.'
      });
    }

    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;

    const requestPayload = {
      contents: [
        {
          parts: [{ text: text.trim() }]
        }
      ],
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: {
              voiceName: voice
            }
          }
        }
      }
    };

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestPayload)
    });

    const data = await response.json();

    if (!response.ok) {
      const errMsg = data.error?.message || 'Gemini API failed to generate audio.';
      return res.status(response.status).json({ error: errMsg });
    }

    const inlineData = data.candidates?.[0]?.content?.parts?.[0]?.inlineData;
    if (!inlineData?.data) {
      return res.status(500).json({ error: 'Model did not return audio data. Try tweaking the prompt.' });
    }

    const rawBuffer = Buffer.from(inlineData.data, 'base64');
    let wavBuffer = rawBuffer;

    // If Gemini outputs raw PCM, prepend standard 44-byte RIFF WAV header
    const isAlreadyWav = rawBuffer.length > 4 && rawBuffer.toString('ascii', 0, 4) === 'RIFF';
    if (!isAlreadyWav) {
      wavBuffer = buildWavHeader(rawBuffer, 24000, 1, 16);
    }

    res.setHeader('Content-Type', 'audio/wav');
    res.setHeader('Content-Disposition', `inline; filename="${voice.toLowerCase()}-${Date.now()}.wav"`);
    return res.status(200).send(wavBuffer);

  } catch (err) {
    console.error('Server error:', err);
    return res.status(500).json({ error: err.message || 'Internal server error.' });
  }
}

// 44-byte RIFF WAV Header for 24kHz 16-bit Mono PCM
function buildWavHeader(pcmBuffer, sampleRate = 24000, channels = 1, bitDepth = 16) {
  const byteRate = (sampleRate * channels * bitDepth) / 8;
  const blockAlign = (channels * bitDepth) / 8;
  const dataLength = pcmBuffer.length;
  const header = Buffer.alloc(44);

  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataLength, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitDepth, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataLength, 40);

  return Buffer.concat([header, pcmBuffer]);
}