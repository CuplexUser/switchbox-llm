// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelInfo, ModelRef } from '../../shared/types.ts';
import { ModelPicker } from './ModelPicker.tsx';

function model(provider: ModelInfo['provider'], id: string, name: string): ModelInfo {
  return { provider, model: id, name } as ModelInfo;
}

const RESPONSES: Record<string, unknown> = {
  '/api/models': {
    models: [model('openrouter', 'vendor/alpha', 'Alpha'), model('openrouter', 'vendor/beta', 'Beta'), model('anthropic', 'claude-x', 'Claude X')],
    errors: [],
  },
  '/api/providers': [
    { id: 'openrouter', ready: true },
    { id: 'anthropic', ready: true },
  ],
  '/api/settings': { favorites: [{ provider: 'anthropic', model: 'claude-x' }] },
};

let requests: { url: string; init?: RequestInit }[] = [];

function renderPicker(onSelect: (ref: ModelRef) => void) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // The popover hands focus back to what had it when it closes, so give it a real element.
  const anchor = document.body.appendChild(document.createElement('button'));
  anchor.focus();
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <ModelPicker anchorEl={anchor} open onClose={() => undefined} onSelect={onSelect} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** Each option's main line, without the provider badge or the id under it. */
const optionNames = () => screen.getAllByRole('option').map((option) => option.querySelector('p')?.textContent ?? '');

beforeEach(() => {
  requests = [];
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    requests.push({ url, init });
    const body = RESPONSES[url] ?? {};
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
});

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe('ModelPicker', () => {
  it('lists favorites first, then each ready provider', async () => {
    renderPicker(() => undefined);
    await screen.findByText('Alpha');
    const names = optionNames();
    expect(names).toEqual(['Claude X', 'Alpha', 'Beta', 'Claude X']);
  });

  it('filters by every word typed and picks with the keyboard', async () => {
    const onSelect = vi.fn<(ref: ModelRef) => void>();
    renderPicker(onSelect);
    await screen.findByText('Alpha');
    const search = screen.getByLabelText('Search models');

    fireEvent.change(search, { target: { value: 'vendor bet' } });
    // No model has that exact id, so it is also offered as an id on each provider.
    await vi.waitFor(() => expect(optionNames()).toEqual(['Beta', 'Use “vendor bet” on OpenRouter', 'Use “vendor bet” on Anthropic']));
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(onSelect).toHaveBeenLastCalledWith({ provider: 'openrouter', model: 'vendor/beta' });

    fireEvent.change(search, { target: { value: 'vendor bet' } });
    for (const key of ['ArrowDown', 'ArrowDown', 'ArrowDown', 'ArrowUp', 'Enter']) fireEvent.keyDown(search, { key });
    expect(onSelect).toHaveBeenLastCalledWith({ provider: 'openrouter', model: 'vendor bet' });
  });

  it('offers an unknown id on every ready provider', async () => {
    const onSelect = vi.fn<(ref: ModelRef) => void>();
    renderPicker(onSelect);
    await screen.findByText('Alpha');
    fireEvent.change(screen.getByLabelText('Search models'), { target: { value: 'brand-new-model' } });

    const offer = await screen.findByText('Use “brand-new-model” on Anthropic');
    fireEvent.click(offer);
    expect(onSelect).toHaveBeenCalledWith({ provider: 'anthropic', model: 'brand-new-model' });
  });

  it('saves a new favorite', async () => {
    renderPicker(() => undefined);
    await screen.findByText('Alpha');
    const alpha = screen.getAllByRole('option').find((option) => option.querySelector('p')?.textContent === 'Alpha');
    if (!alpha) throw new Error('Alpha is not listed');
    fireEvent.click(within(alpha).getByLabelText('Add to favorites'));

    await vi.waitFor(() => expect(requests.some((entry) => entry.init?.method === 'PUT')).toBe(true));
    const saved = requests.find((entry) => entry.init?.method === 'PUT');
    expect(saved?.url).toBe('/api/settings/favorites');
    expect(JSON.parse(String(saved?.init?.body))).toEqual([
      { provider: 'anthropic', model: 'claude-x' },
      { provider: 'openrouter', model: 'vendor/alpha' },
    ]);
  });
});
