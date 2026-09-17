import Box from '@mui/material/Box';
import MenuItem from '@mui/material/MenuItem';
import TextField from '@mui/material/TextField';
import { REASONING_EFFORTS, type GenerationParams, type ReasoningEffort } from '../../../shared/types.ts';

type NumberKey = 'temperature' | 'topP' | 'maxTokens' | 'thinkingBudget';

const FIELDS: { key: NumberKey; label: string; min: number; max: number; step: number; help: string }[] = [
  { key: 'temperature', label: 'Temperature', min: 0, max: 2, step: 0.1, help: '0 to 2. Higher is more varied.' },
  { key: 'topP', label: 'Top P', min: 0, max: 1, step: 0.05, help: '0 to 1. Nucleus sampling.' },
  { key: 'maxTokens', label: 'Max output tokens', min: 1, max: 1_000_000, step: 1, help: 'Upper bound on reply length.' },
  {
    key: 'thinkingBudget',
    label: 'Thinking budget',
    min: 1024,
    max: 1_000_000,
    step: 1024,
    help: 'Tokens for thinking, for models that take a budget. At least 1,024.',
  },
];

const EFFORT_LABELS: Record<ReasoningEffort, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
};

export function ParamsFields({
  value,
  onChange,
  placeholders,
}: {
  value: Partial<GenerationParams>;
  onChange: (value: Partial<GenerationParams>) => void;
  placeholders?: GenerationParams;
}) {
  const fallbackEffort = placeholders?.reasoningEffort;
  return (
    <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: 'repeat(3, 1fr)' }, columnGap: 1.5, rowGap: 2.5 }}>
      {FIELDS.map((field) => {
        const current = value[field.key];
        const fallback = placeholders?.[field.key];
        const outOfRange = current !== null && current !== undefined && (current < field.min || current > field.max);
        return (
          <TextField
            key={field.key}
            type="number"
            label={field.label}
            value={current ?? ''}
            placeholder={fallback !== null && fallback !== undefined ? String(fallback) : 'Provider default'}
            error={outOfRange}
            helperText={field.help}
            onChange={(event) => {
              const raw = event.target.value;
              const parsed = raw === '' ? null : Number(raw);
              onChange({ ...value, [field.key]: parsed === null || Number.isNaN(parsed) ? null : parsed });
            }}
            slotProps={{ inputLabel: { shrink: true }, htmlInput: { min: field.min, max: field.max, step: field.step } }}
          />
        );
      })}
      <TextField
        select
        label="Reasoning effort"
        value={value.reasoningEffort ?? ''}
        helperText="How hard reasoning models think. Others ignore it."
        onChange={(event) => onChange({ ...value, reasoningEffort: (event.target.value || null) as ReasoningEffort | null })}
        slotProps={{ inputLabel: { shrink: true }, select: { displayEmpty: true } }}
      >
        <MenuItem value="">{fallbackEffort ? `Default (${EFFORT_LABELS[fallbackEffort]})` : 'Provider default'}</MenuItem>
        {REASONING_EFFORTS.map((effort) => (
          <MenuItem key={effort} value={effort}>
            {EFFORT_LABELS[effort]}
          </MenuItem>
        ))}
      </TextField>
    </Box>
  );
}
