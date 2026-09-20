import { describe, expect, it } from 'vitest';
import { FakeProvider, doneMessage, send, setup } from './testing.ts';

describe('image-generating panes', () => {
  it('saves a generated image as an attachment, with no tool loop', async () => {
    // The real PNG signature bytes; AttachmentService.classify() checks these, not the declared mime type.
    const pngHeader = 'iVBORw0KGgo=';
    const provider = new FakeProvider(() => [
      { type: 'image', mimeType: 'image/png', data: pngHeader },
      { type: 'finish', reason: 'stop' },
    ]);
    const services = setup(provider);
    const conversation = await services.repos.conversations.create({
      title: 'New chat',
      persist: true,
      useMemory: false,
      webAccess: true,
      workspace: false,
      toolGroups: null,
      pinned: false,
      archived: false,
    });
    const pane = await services.repos.panes.create({
      conversationId: conversation.id,
      position: 0,
      provider: 'google',
      model: 'gemini-2.5-flash-image',
      systemPromptId: null,
      systemPrompt: null,
      params: {},
    });

    const events = await send(services, conversation.id, [pane.id], 'A nano banana on a table');
    const message = doneMessage(events);

    expect(message?.attachments).toMatchObject([{ kind: 'image', mimeType: 'image/png' }]);
    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]?.imageOutput).toBe(true);
    expect(provider.requests[0]?.tools).toEqual([]);
  });
});
