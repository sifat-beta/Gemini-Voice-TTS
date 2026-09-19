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

    // Google's dedicated Gemini TTS models that output audio bytes
    const candidateModels = [
      'gemini-2.5-flash-preview-tts',
      'gemini-2.5-flash-tts',
      'gemini-2.5-flash',
      'gemini-2.0-flash-exp'
    ];

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

    let audioBuffer = null;
    let lastErrorMsg = '';

    // Attempt generation across available TTS models
    for (const model of candidateModels) {
      const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

      try {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(requestPayload)
        });

        const data = await response.json();

        if (!response.ok) {
          lastErrorMsg = data.error?.message || `HTTP ${response.status}`;
          continue; // Try the next model candidate
        }

        const parts = data.candidates?.[0]?.content?.parts || [];
        const audioPart = parts.find(p => p.inlineData && p.inlineData.data);

        if (audioPart?.inlineData?.data) {
          audioBuffer = Buffer.from(audioPart.inlineData.data, 'base64');
          break; // Successfully obtained audio
        } else {
          const textReply = parts.find(p => p.text)?.text;
          lastErrorMsg = textReply ? `Model returned text: "${textReply}"` : 'No audio returned.';
        }
      } catch (err) {
        lastErrorMsg = err.message;
      }
    }

    if (!audioBuffer) {
      return res.status(500).json({
        error: `Could not synthesize audio stream. ${lastErrorMsg}`
      });
    }

    // Wrap raw 24kHz PCM in a standard 44-byte WAV container if needed
    const isWav = audioBuffer.length > 4 && audioBuffer.toString('ascii', 0, 4) === 'RIFF';
    const finalBuffer = isWav ? audioBuffer : buildWavHeader(audioBuffer, 24000, 1, 16);

    res.setHeader('Content-Type', 'audio/wav');
    res.setHeader('Content-Disposition', `inline; filename="titun-${voice.toLowerCase()}-${Date.now()}.wav"`);
    return res.status(200).send(finalBuffer);

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
  header.writeUInt16LE(1, 20); // 1 = PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitDepth, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataLength, 40);

  return Buffer.concat([header, pcmBuffer]);
}