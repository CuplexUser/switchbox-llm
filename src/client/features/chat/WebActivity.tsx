import ArticleOutlinedIcon from '@mui/icons-material/ArticleOutlined';
import ExpandMoreRoundedIcon from '@mui/icons-material/ExpandMoreRounded';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import PsychologyAltOutlinedIcon from '@mui/icons-material/PsychologyAltOutlined';
import PublicRoundedIcon from '@mui/icons-material/PublicRounded';
import SearchRoundedIcon from '@mui/icons-material/SearchRounded';
import Box from '@mui/material/Box';
import ButtonBase from '@mui/material/ButtonBase';
import Collapse from '@mui/material/Collapse';
import Typography from '@mui/material/Typography';
import { useState } from 'react';
import type { ActivityItem, SearchEngine, Source } from '../../../shared/types.ts';

const ENGINE_LABELS: Record<SearchEngine, string> = {
  tavily: 'Tavily',
  brave: 'Brave',
  native: 'provider search',
};

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

function shortUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname === '/' ? '' : parsed.pathname;
    const full = `${parsed.hostname.replace(/^www\./, '')}${path}`;
    return full.length > 64 ? `${full.slice(0, 61)}…` : full;
  } catch {
    return url;
  }
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function summarize(items: ActivityItem[], sources: Source[]): string {
  const count = (kind: ActivityItem['kind'], failed: boolean) =>
    items.filter((item) => item.kind === kind && Boolean('error' in item && item.error) === failed).length;
  const searches = count('search', false);
  const fetches = count('fetch', false);
  const memories = (action: 'save' | 'forget') =>
    items.filter((item) => item.kind === 'memory' && item.action === action && !item.error).length;
  const saved = memories('save');
  const forgotten = memories('forget');
  const failures = count('search', true) + count('fetch', true) + count('memory', true);
  const parts = [
    searches ? `Searched ${searches === 1 ? 'once' : `${searches} times`}` : null,
    fetches ? `read ${plural(fetches, 'page', 'pages')}` : null,
    saved ? `saved ${plural(saved, 'memory', 'memories')}` : null,
    forgotten ? `forgot ${plural(forgotten, 'memory', 'memories')}` : null,
    failures ? `${plural(failures, 'step', 'steps')} failed` : null,
    sources.length ? plural(sources.length, 'source', 'sources') : null,
  ].filter((part): part is string => Boolean(part));
  const text = parts.join(', ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function runningLabel(item: ActivityItem): string | null {
  if (item.done) return null;
  if (item.kind === 'search') return `Searching “${item.query}”`;
  if (item.kind === 'fetch') return `Reading ${shortUrl(item.url)}`;
  if (item.kind === 'memory') return item.action === 'save' ? 'Saving to memory' : 'Removing from memory';
  return null;
}

function Step({ item }: { item: Exclude<ActivityItem, { kind: 'notice' }> }) {
  const icon =
    item.kind === 'search' ? (
      <SearchRoundedIcon sx={{ fontSize: 15 }} />
    ) : item.kind === 'memory' ? (
      <PsychologyAltOutlinedIcon sx={{ fontSize: 15 }} />
    ) : (
      <ArticleOutlinedIcon sx={{ fontSize: 15 }} />
    );
  let detail: string | null = null;
  if (item.error) detail = item.error;
  else if (item.kind === 'search' && item.resultCount !== null) detail = plural(item.resultCount, 'result', 'results');
  else if (!item.done) detail = 'In progress';
  else if (item.kind === 'memory') detail = item.action === 'save' ? 'Saved to memory' : 'Removed from memory';

  return (
    <Box sx={{ display: 'flex', gap: 1, alignItems: 'flex-start', py: 0.375 }}>
      <Box sx={{ color: 'var(--sb-text-faint)', pt: '2px', flexShrink: 0 }}>{icon}</Box>
      <Box sx={{ minWidth: 0 }}>
        {item.kind === 'search' ? (
          <Typography variant="body2" sx={{ fontSize: '0.8125rem', overflowWrap: 'anywhere' }}>
            “{item.query}”
            <Box component="span" sx={{ color: 'var(--sb-text-faint)' }}>
              {' '}
              via {ENGINE_LABELS[item.engine]}
            </Box>
          </Typography>
        ) : item.kind === 'memory' ? (
          <Typography variant="body2" sx={{ fontSize: '0.8125rem', overflowWrap: 'anywhere' }}>
            {item.content}
          </Typography>
        ) : (
          <Typography
            variant="body2"
            component="a"
            href={item.url}
            target="_blank"
            rel="noreferrer noopener"
            sx={{ fontSize: '0.8125rem', color: 'var(--sb-text)', overflowWrap: 'anywhere', textUnderlineOffset: '2px' }}
          >
            {shortUrl(item.url)}
          </Typography>
        )}
        {detail && (
          <Typography
            variant="caption"
            component="div"
            sx={{ color: item.error ? 'error.main' : 'var(--sb-text-faint)', overflowWrap: 'anywhere' }}
          >
            {detail}
          </Typography>
        )}
      </Box>
    </Box>
  );
}

export function WebActivity({ items, sources, live = false }: { items: ActivityItem[]; sources: Source[]; live?: boolean }) {
  const [open, setOpen] = useState(false);
  const notices = items.filter((item): item is Extract<ActivityItem, { kind: 'notice' }> => item.kind === 'notice');
  const steps = items.filter((item): item is Exclude<ActivityItem, { kind: 'notice' }> => item.kind !== 'notice');
  const running = live ? steps.map(runningLabel).findLast(Boolean) : null;
  const hasDetail = steps.length > 0 || sources.length > 0;
  const memoryOnly = sources.length === 0 && steps.every((item) => item.kind === 'memory');

  if (notices.length === 0 && !hasDetail) return null;

  return (
    <Box sx={{ mb: 1.5 }}>
      {notices.map((notice) => (
        <Typography
          key={notice.id}
          variant="caption"
          component="div"
          sx={{ display: 'flex', gap: 0.75, alignItems: 'flex-start', color: 'var(--sb-text-muted)', mb: 0.75 }}
        >
          <InfoOutlinedIcon sx={{ fontSize: 14, mt: '1px' }} />
          {notice.text}
        </Typography>
      ))}

      {hasDetail && (
        <>
          <ButtonBase
            onClick={() => setOpen((value) => !value)}
            aria-expanded={open}
            sx={{
              gap: 0.75,
              px: 0.75,
              py: 0.25,
              ml: -0.75,
              maxWidth: '100%',
              borderRadius: '6px',
              color: 'var(--sb-text-faint)',
              fontSize: '0.75rem',
              fontWeight: 550,
              '&:hover': { color: 'var(--sb-text-muted)' },
              '&:focus-visible': { outline: '2px solid var(--sb-ink)' },
            }}
          >
            {running ? (
              <Box
                aria-hidden
                sx={{
                  width: 7,
                  height: 7,
                  flexShrink: 0,
                  borderRadius: '50%',
                  backgroundColor: 'var(--sb-pane-color, var(--sb-ink))',
                  animation: 'sb-web-pulse 1.1s ease-in-out infinite',
                  '@keyframes sb-web-pulse': { '50%': { opacity: 0.3 } },
                }}
              />
            ) : memoryOnly ? (
              <PsychologyAltOutlinedIcon sx={{ fontSize: 15 }} />
            ) : (
              <PublicRoundedIcon sx={{ fontSize: 15 }} />
            )}
            <Box component="span" sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} aria-live="polite">
              {running ? `${running}…` : summarize(steps, sources)}
            </Box>
            <ExpandMoreRoundedIcon
              sx={{ fontSize: 16, flexShrink: 0, transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 150ms ease' }}
            />
          </ButtonBase>

          <Collapse in={open}>
            <Box sx={{ mt: 0.75, pl: 1.5, borderLeft: '2px solid var(--sb-border)' }}>
              {steps.map((item) => (
                <Step key={item.id} item={item} />
              ))}
              {sources.length > 0 && (
                <Box sx={{ mt: steps.length ? 1 : 0 }}>
                  <Typography variant="caption" component="div" sx={{ color: 'var(--sb-text-faint)', fontWeight: 600, mb: 0.5 }}>
                    Sources
                  </Typography>
                  <Box component="ol" sx={{ m: 0, pl: 2.5, display: 'flex', flexDirection: 'column', gap: 0.375 }}>
                    {sources.map((source) => (
                      <Box component="li" key={source.url} sx={{ fontSize: '0.8125rem', color: 'var(--sb-text-faint)' }}>
                        <Box
                          component="a"
                          href={source.url}
                          target="_blank"
                          rel="noreferrer noopener"
                          sx={{ color: 'var(--sb-text)', textUnderlineOffset: '2px', overflowWrap: 'anywhere' }}
                        >
                          {source.title === source.url ? shortUrl(source.url) : source.title}
                        </Box>
                        {source.title !== source.url && <Box component="span"> {hostOf(source.url)}</Box>}
                      </Box>
                    ))}
                  </Box>
                </Box>
              )}
            </Box>
          </Collapse>
        </>
      )}
    </Box>
  );
}
