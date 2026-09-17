import Box from '@mui/material/Box';
import TextField from '@mui/material/TextField';
import type { GenerationParams } from '../../../shared/types.ts';

type NumberKey = 'temperature' | 'topP' | 'maxTokens';

const FIELDS: { key: NumberKey; label: string; min: number; max: number; step: number; help: string }[] = [
  { key: 'temperature', label: 'Temperature', min: 0, max: 2, step: 0.1, help: '0 to 2. Higher is more varied.' },
  { key: 'topP', label: 'Top P', min: 0, max: 1, step: 0.05, help: '0 to 1. Nucleus sampling.' },
  { key: 'maxTokens', label: 'Max output tokens', min: 1, max: 1_000_000, step: 1, help: 'Upper bound on reply length.' },
];

export function ParamsFields({
  value,
  onChange,
  placeholders,
}: {
  value: Partial<GenerationParams>;
  onChange: (value: Partial<GenerationParams>) => void;
  placeholders?: GenerationParams;
}) {
  return (
    <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: 'repeat(3, 1fr)' }, gap: 1.5 }}>
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
    </Box>
  );
}
