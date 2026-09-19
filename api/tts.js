export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    const { text, voice = 'Puck' } = req.body;

    if (!text || !text.trim()) {
      return res.status(400).json({ error: 'Text prompt cannot be empty.' });
    }

    const apiKey = process.env.GEMINI_API_KEY;

    if (!apiKey) {
      return res.status(500).json({
        error: 'GEMINI_API_KEY environment variable is not set in Vercel.'
      });
    }

    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${apiKey}`;

    const requestPayload = {
      // Directs Gemini to act strictly as a verbatim text-to-speech reader
      systemInstruction: {
        parts: [
          {
            text: "You are a professional text-to-speech engine. Read the user's text out loud verbatim. Do not converse, do not answer questions, and do not add any extra commentary or words. Recite only the exact words provided by the user."
          }
        ]
      },
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
      const errMsg = data.error?.message || 'Gemini API speech generation failed.';
      return res.status(response.status).json({ error: errMsg });
    }

    // Search across all returned parts for the audio data
    const parts = data.candidates?.[0]?.content?.parts || [];
    const audioPart = parts.find(p => p.inlineData && p.inlineData.data);

    if (!audioPart || !audioPart.inlineData?.data) {
      // Check if the model returned a refusal or text message instead
      const textPart = parts.find(p => p.text)?.text;
      const detail = textPart ? ` Model responded with: "${textPart}"` : '';
      return res.status(500).json({ error: `Audio stream not found in model response.${detail}` });
    }

    const rawBuffer = Buffer.from(audioPart.inlineData.data, 'base64');
    let wavBuffer = rawBuffer;

    // Convert raw 24kHz PCM to RIFF WAV if needed
    const isAlreadyWav = rawBuffer.length > 4 && rawBuffer.toString('ascii', 0, 4) === 'RIFF';
    if (!isAlreadyWav) {
      wavBuffer = buildWavHeader(rawBuffer, 24000, 1, 16);
    }

    res.setHeader('Content-Type', 'audio/wav');
    res.setHeader('Content-Disposition', `inline; filename="titun-${voice.toLowerCase()}-${Date.now()}.wav"`);
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