import { describe, expect, it } from 'vitest';
import { pcmToWav, readWav } from '../providers/audio.ts';
import { classify } from './attachments.ts';
import { speakableText, splitForSpeech } from './speech.ts';
import { FakeProvider, doneMessage, send, setup } from './testing.ts';

const MP3 = Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00]).toString('base64');

async function speechPane(services: ReturnType<typeof setup>, model: string) {
  const conversation = await services.repos.conversations.create({
    title: 'New chat',
    persist: true,
    useMemory: true,
    webAccess: true,
    workspace: false,
    toolGroups: null,
    pinned: false,
    archived: false,
  });
  const pane = await services.repos.panes.create({
    conversationId: conversation.id,
    position: 0,
    provider: 'openrouter',
    model,
    systemPromptId: null,
    systemPrompt: null,
    params: {},
  });
  return { conversation, pane };
}

function bytes(values: number[] | string): Uint8Array {
  return typeof values === 'string' ? new TextEncoder().encode(values) : new Uint8Array(values);
}

describe('audio attachments', () => {
  it('recognizes audio by its bytes', () => {
    expect(classify('a', '', bytes('ID3\u0004'))?.mimeType).toBe('audio/mpeg');
    expect(classify('a', '', bytes([0xff, 0xfb, 0x90, 0x00]))?.mimeType).toBe('audio/mpeg');
    expect(classify('a', '', bytes([0xff, 0xf1, 0x50, 0x80]))?.mimeType).toBe('audio/aac');
    expect(classify('a', '', bytes('OggS\u0000'))?.mimeType).toBe('audio/ogg');
    expect(classify('a', '', bytes('fLaC'))?.mimeType).toBe('audio/flac');
    expect(classify('a', '', new Uint8Array(pcmToWav(new Uint8Array([0, 0])))))?.toEqual({ kind: 'audio', mimeType: 'audio/wav' });
    // WebP shares RIFF with WAV and still reads as an image.
    expect(classify('a', '', bytes('RIFF\u0000\u0000\u0000\u0000WEBPVP8 '))?.kind).toBe('image');
  });

  it('refuses audio uploads, since no model is sent audio', async () => {
    const services = setup(new FakeProvider(() => []));
    await expect(services.attachments.create({ name: 'clip.mp3', mimeType: 'audio/mpeg', data: MP3 })).rejects.toThrow("isn't a supported file");
    const generated = await services.attachments.create({ name: 'clip.mp3', mimeType: 'audio/mpeg', data: MP3, generated: true });
    expect(generated.kind).toBe('audio');
    expect(await services.attachments.load([generated])).toEqual([]);
  });
});

describe('speech panes', () => {
  it('save the spoken message as audio, with no tools, and never send audio back', async () => {
    const provider = new FakeProvider(() => [
      { type: 'audio', mimeType: 'audio/mpeg', data: MP3 },
      { type: 'finish', reason: 'stop' },
    ]);
    const services = setup(provider);
    const { conversation, pane } = await speechPane(services, 'openai/gpt-4o-mini-tts');

    const message = doneMessage(await send(services, conversation.id, [pane.id], 'Good morning'));
    expect(message?.attachments).toMatchObject([{ kind: 'audio', mimeType: 'audio/mpeg', name: expect.stringMatching(/^speech-\d+\.mp3$/) }]);
    expect(provider.requests[0]).toMatchObject({ speechOutput: true, imageOutput: false, tools: [], nativeSearch: false });

    await send(services, conversation.id, [pane.id], 'Good night');
    const history = provider.requests[1]?.messages ?? [];
    expect(history.at(-1)).toEqual({ role: 'user', content: 'Good night' });
    expect(history.some((entry) => entry.role === 'assistant')).toBe(false);
  });
});

describe('read aloud', () => {
  it('turns markdown into speakable text', () => {
    const text = speakableText(
      '# Title\n\nSome **bold** and _soft_ text with a [link](https://x.y) and `code`.\n\n```js\nconst a = 1;\n```\n\n- one\n- two\n\n| a | b |\n| - | - |\n| 1 | 2 |',
    );
    expect(text).toBe('Title\n\nSome bold and soft text with a link and code.\n\n(Code block omitted.)\n\none\ntwo\n\n(Table omitted.)');
  });

  it('splits long text at paragraphs, then sentences, then words', () => {
    expect(splitForSpeech('a b\n\nc d', 100)).toEqual(['a b\n\nc d']);
    expect(splitForSpeech('First one.\n\nSecond one.', 12)).toEqual(['First one.', 'Second one.']);
    expect(splitForSpeech('One two three. Four five six.', 16)).toEqual(['One two three.', 'Four five six.']);
    const pieces = splitForSpeech('word '.repeat(50).trim(), 22);
    expect(pieces.every((piece) => piece.length <= 22)).toBe(true);
    expect(pieces.join(' ')).toBe('word '.repeat(50).trim());
  });

  it('speaks long replies in pieces with the chosen model and joins them', async () => {
    const provider = new FakeProvider((request) => [
      { type: 'audio', mimeType: 'audio/wav', data: pcmToWav(new TextEncoder().encode(request.messages[0]?.content.slice(0, 2) ?? '')).toString('base64') },
    ]);
    const services = setup(provider);
    await expect(services.speech.readAloud('Hi', new AbortController().signal)).rejects.toThrow('Choose a speech model');

    await services.settings.set('general', { ...(await services.settings.get('general')), speechModel: { provider: 'openrouter', model: 'openai/gpt-4o-mini-tts' } });
    await services.settings.set('generation', { ...(await services.settings.get('generation')), audioFormat: 'wav', voice: 'nova' });
    const paragraph = 'Words. '.repeat(500).trim();
    const audio = await services.speech.readAloud(`${paragraph}\n\n${paragraph}`, new AbortController().signal);

    expect(provider.requests).toHaveLength(2);
    expect(provider.requests[0]).toMatchObject({ model: 'openai/gpt-4o-mini-tts', speechOutput: true, params: { voice: 'nova', audioFormat: 'wav' } });
    expect(audio.mimeType).toBe('audio/wav');
    expect(readWav(audio.data)?.pcm.toString()).toBe('WoWo');
  });

  it('refuses a model that is not a speech model', async () => {
    const services = setup(new FakeProvider(() => []));
    await services.settings.set('general', { ...(await services.settings.get('general')), speechModel: { provider: 'openrouter', model: 'test/chat-model' } });
    await expect(services.speech.readAloud('Hi', new AbortController().signal)).rejects.toThrow("isn't a speech model");
  });
});
