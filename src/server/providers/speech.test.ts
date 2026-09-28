import { afterEach, describe, expect, it, vi } from 'vitest';
import { isImageModel, isSpeechModel, mergeParams } from '../../shared/defaults.ts';
import { voiceFor } from '../../shared/speech.ts';
import { joinAudio, pcmToWav, readWav } from './audio.ts';
import { GoogleProvider, geminiSpeechBody, interactionAudio, parseDialogue } from './google.ts';
import { mapModels, OpenAiCompatibleProvider, speechRequest } from './openaiCompatible.ts';
import type { ChatEvent, ChatRequest } from './types.ts';

function speechCall(model: string, params = mergeParams()): ChatRequest {
  return {
    model,
    system: '',
    messages: [
      { role: 'user', content: 'An earlier line' },
      { role: 'assistant', content: '' },
      { role: 'user', content: 'Read this, please.' },
    ],
    params,
    signal: new AbortController().signal,
    speechOutput: true,
  };
}

async function collect(stream: AsyncIterable<ChatEvent>): Promise<ChatEvent[]> {
  const events: ChatEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('speech models', () => {
  it('are recognized from the model list, or from a tts id when the list is not loaded', () => {
    expect(isSpeechModel({ provider: 'openai', model: 'gpt-4o-mini-tts' }, null)).toBe(true);
    expect(isSpeechModel({ provider: 'openrouter', model: 'google/gemini-3.8-flash-tts' }, null)).toBe(true);
    expect(isSpeechModel({ provider: 'openrouter', model: 'microsoft/mai-voice-2' }, { provider: 'openrouter', model: 'microsoft/mai-voice-2', name: 'MAI', kind: 'speech' })).toBe(true);
    expect(isSpeechModel({ provider: 'openai', model: 'gpt-4.1' }, null)).toBe(false);
    expect(isSpeechModel({ provider: 'ollama', model: 'some-tts' }, null)).toBe(false);
    // Every other direct Google model is an image model; its speech models are not.
    expect(isImageModel({ provider: 'google', model: 'gemini-3.8-flash-tts' }, null)).toBe(false);
    expect(isImageModel({ provider: 'google', model: 'gemini-2.5-flash-image' }, null)).toBe(true);
  });

  it('are tagged in each catalog, with OpenRouter speech models winning over a duplicate plain entry', () => {
    const openai = mapModels('openai', [{ id: 'tts-1' }, { id: 'gpt-4o-mini-tts' }, { id: 'whisper-1' }, { id: 'gpt-4o-audio-preview' }]);
    expect(openai.map((model) => [model.model, model.kind])).toEqual([
      ['gpt-4o-mini-tts', 'speech'],
      ['tts-1', 'speech'],
    ]);
    const openrouter = mapModels('openrouter', [
      { id: 'openai/gpt-4o-mini-tts', architecture: { output_modalities: ['speech'] } },
      { id: 'openai/gpt-4o-mini-tts', architecture: { output_modalities: ['text'] } },
    ]);
    expect(openrouter).toHaveLength(1);
    expect(openrouter[0]?.kind).toBe('speech');
  });

  it('picks a voice that suits the model', () => {
    expect(voiceFor({ provider: 'openai', model: 'tts-1' }, null)).toBe('alloy');
    expect(voiceFor({ provider: 'openai', model: 'tts-1' }, 'Nova')).toBe('nova');
    // A Gemini voice on an OpenAI model would be rejected, so the default is used.
    expect(voiceFor({ provider: 'openai', model: 'tts-1' }, 'Kore')).toBe('alloy');
    expect(voiceFor({ provider: 'google', model: 'gemini-3.8-flash-tts' }, 'alloy')).toBe('Kore');
    // Names this list doesn't know go through.
    expect(voiceFor({ provider: 'openai', model: 'tts-1' }, 'brand-new')).toBe('brand-new');
    expect(voiceFor({ provider: 'openrouter', model: 'someone/voice' }, null)).toBeNull();
  });
});

describe('OpenAI-style /audio/speech', () => {
  it('builds each dialect of the request body', () => {
    const params = mergeParams({ voice: 'coral', speechSpeed: 1.25, speechStyle: 'warm', audioFormat: 'wav' });
    expect(speechRequest('openai', 'gpt-4o-mini-tts', 'Hi', params)).toEqual({
      body: { model: 'gpt-4o-mini-tts', input: 'Hi', response_format: 'wav', voice: 'coral', speed: 1.25, instructions: 'warm' },
      format: 'wav',
      wrapPcm: false,
    });
    expect(speechRequest('openai', 'tts-1', 'Hi', params).body.instructions).toBeUndefined();

    const routed = speechRequest('openrouter', 'openai/gpt-4o-mini-tts', 'Hi', params);
    expect(routed.body).toMatchObject({ response_format: 'pcm', provider: { options: { openai: { instructions: 'warm' } } } });
    expect(routed.wrapPcm).toBe(true);
    // OpenRouter has no FLAC, so MP3 is asked for.
    expect(speechRequest('openrouter', 'mistralai/voxtral-mini-tts-2603', 'Hi', mergeParams({ audioFormat: 'flac' })).body).toEqual({
      model: 'mistralai/voxtral-mini-tts-2603',
      input: 'Hi',
      response_format: 'mp3',
      voice: 'en_paul_neutral',
    });
  });

  it('speaks the latest user message and wraps OpenRouter PCM as WAV', async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () => new Response(new Uint8Array([1, 0, 2, 0]), { status: 200, headers: { 'Content-Type': 'audio/pcm;rate=16000;channels=1' } }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const provider = new OpenAiCompatibleProvider({ id: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'key' });
    const events = await collect(provider.streamChat(speechCall('openai/gpt-4o-mini-tts', mergeParams({ audioFormat: 'wav' }))));

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://openrouter.ai/api/v1/audio/speech');
    expect(JSON.parse(init.body as string)).toMatchObject({ input: 'Read this, please.', voice: 'alloy', response_format: 'pcm' });
    const audio = events.find((event) => event.type === 'audio');
    expect(audio).toMatchObject({ type: 'audio', mimeType: 'audio/wav' });
    const wav = readWav(Buffer.from((audio as { data: string }).data, 'base64'));
    expect(wav).toMatchObject({ sampleRate: 16_000, channels: 1, bitsPerSample: 16 });
    expect([...(wav?.pcm ?? [])]).toEqual([1, 0, 2, 0]);
  });

  it('passes MP3 bytes through and reports a JSON error sent with a 200', async () => {
    vi.stubGlobal('fetch', async () => new Response(new Uint8Array([0x49, 0x44, 0x33]), { status: 200, headers: { 'Content-Type': 'audio/mpeg' } }));
    const provider = new OpenAiCompatibleProvider({ id: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: 'key' });
    const events = await collect(provider.streamChat(speechCall('tts-1')));
    expect(events[0]).toEqual({ type: 'audio', mimeType: 'audio/mpeg', data: Buffer.from('ID3').toString('base64') });

    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ error: { message: 'Unknown voice' } }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    await expect(collect(provider.streamChat(speechCall('tts-1')))).rejects.toThrow('Unknown voice');
  });
});

describe('Gemini TTS through the Interactions API', () => {
  it('reads a two-speaker script as a conversation, and anything else with one voice', () => {
    expect(parseDialogue('Joe: How is it going?\nJane: Not bad.\nJoe: Good.')).toHaveLength(3);
    expect(parseDialogue('Joe: Only one speaker.')).toBeNull();
    expect(parseDialogue('Step 1: mix\nStep 2: bake')).toBeNull();
    expect(parseDialogue('Joe: hi\njust a line')).toBeNull();

    const params = mergeParams({ voice: 'Puck', secondVoice: 'Leda', speechStyle: 'cheerful', speechSpeed: 0.6 });
    const dialogue = geminiSpeechBody('gemini-3.8-flash-tts', 'Joe: Hi <laugh>\nJane: Hello', params);
    expect(dialogue).toMatchObject({
      input: [
        {
          type: 'user_input',
          content: [
            { type: 'text', text: 'Hi <laugh>', annotations: [{ type: 'speech_metadata', speaker: 'Joe', style: 'cheerful, speaking slowly' }] },
            { type: 'text', text: 'Hello', annotations: [{ speaker: 'Jane' }] },
          ],
        },
      ],
      response_format: { type: 'audio' },
      generation_config: { speech_config: { mode: 'conversational', speakers: [{ speaker: 'Joe', voice: 'Puck' }, { speaker: 'Jane', voice: 'Leda' }] } },
    });

    expect(geminiSpeechBody('gemini-3.8-flash-tts', 'Have a nice day', mergeParams())).toEqual({
      model: 'gemini-3.8-flash-tts',
      input: [{ type: 'user_input', content: [{ type: 'text', text: 'Have a nice day' }] }],
      response_format: { type: 'audio' },
      generation_config: { speech_config: [{ voice: 'Kore' }] },
    });
  });

  it('takes the last audio block, wrapping raw samples as WAV', () => {
    expect(interactionAudio({ steps: [{ type: 'model_output', content: [{ type: 'audio', data: 'AAA=' }] }] })).toEqual({ mimeType: 'audio/wav', data: 'AAA=' });
    const raw = interactionAudio({ steps: [{ type: 'model_output', content: [{ type: 'audio', data: 'AQACAA==', mime_type: 'audio/l16;rate=24000' }] }] });
    expect(raw?.mimeType).toBe('audio/wav');
    expect(readWav(Buffer.from(raw?.data ?? '', 'base64'))?.sampleRate).toBe(24_000);
    expect(interactionAudio({ steps: [] })).toBeNull();
  });

  it('lists its speech models and calls /interactions', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => Response.json({ steps: [{ type: 'model_output', content: [{ type: 'audio', data: 'UklGRg==' }] }] }));
    vi.stubGlobal('fetch', fetchMock);
    const provider = new GoogleProvider({ baseUrl: 'https://generativelanguage.googleapis.com/v1beta', apiKey: 'key' });
    expect((await provider.listModels()).filter((model) => model.kind === 'speech').map((model) => model.model)).toEqual([
      'gemini-3.8-flash-tts',
      'gemini-3.8-flash-lite-tts',
    ]);
    const events = await collect(provider.streamChat(speechCall('gemini-3.8-flash-tts')));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/interactions');
    expect((init.headers as Record<string, string>)['x-goog-api-key']).toBe('key');
    expect(events[0]).toEqual({ type: 'audio', mimeType: 'audio/wav', data: 'UklGRg==' });
  });
});

describe('joining speech', () => {
  it('joins WAV pieces at the sample level and MP3 pieces byte for byte', () => {
    const first = pcmToWav(new Uint8Array([1, 0]), 24_000);
    const second = pcmToWav(new Uint8Array([2, 0, 3, 0]), 24_000);
    const joined = joinAudio([
      { mimeType: 'audio/wav', data: first },
      { mimeType: 'audio/wav', data: second },
    ]);
    expect([...(readWav(joined.data)?.pcm ?? [])]).toEqual([1, 0, 2, 0, 3, 0]);

    const mp3 = joinAudio([
      { mimeType: 'audio/mpeg', data: Buffer.from([1, 2]) },
      { mimeType: 'audio/mpeg', data: Buffer.from([3]) },
    ]);
    expect([...mp3.data]).toEqual([1, 2, 3]);
  });
});
