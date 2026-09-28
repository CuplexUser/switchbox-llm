import Autocomplete from '@mui/material/Autocomplete';
import Box from '@mui/material/Box';
import MenuItem from '@mui/material/MenuItem';
import TextField from '@mui/material/TextField';
import {
  ASPECT_RATIOS,
  AUDIO_FORMATS,
  type AudioFormat,
  IMAGE_QUALITIES,
  IMAGE_SIZES,
  REASONING_EFFORTS,
  type AspectRatio,
  type GenerationParams,
  type ImageQuality,
  type ImageSize,
  type ReasoningEffort,
} from '../../../shared/types.ts';

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

const FORMAT_LABELS: Record<AudioFormat, string> = { mp3: 'MP3', wav: 'WAV', opus: 'Opus', aac: 'AAC', flac: 'FLAC' };

/**
 * Options for text-to-speech models. Voices differ per provider, so the voice is free text with the
 * known ones offered; a voice meant for another provider falls back to the model's own default.
 */
export function SpeechParamsFields({
  value,
  onChange,
  placeholders,
  voices,
  defaultVoices = [],
  formats = [...AUDIO_FORMATS],
  twoSpeakers = true,
}: {
  value: Partial<GenerationParams>;
  onChange: (value: Partial<GenerationParams>) => void;
  placeholders?: GenerationParams;
  /** The voices to suggest. */
  voices: string[];
  /** What an empty first and second voice fall back to, when it's known. */
  defaultVoices?: string[];
  /** The formats this model can return. */
  formats?: AudioFormat[];
  /** Offer a second voice, for Gemini's two-speaker scripts. */
  twoSpeakers?: boolean;
}) {
  const speed = value.speechSpeed;
  const badSpeed = speed !== null && speed !== undefined && (speed < 0.25 || speed > 4);
  const voiceField = (key: 'voice' | 'secondVoice', label: string, help: string, fallback: string | undefined) => (
    <Autocomplete
      freeSolo
      options={voices}
      value={value[key] ?? ''}
      onInputChange={(_, text) => onChange({ ...value, [key]: text.trim() || null })}
      renderInput={(params) => (
        <TextField
          {...params}
          label={label}
          placeholder={placeholders?.[key] ?? fallback ?? 'Model default'}
          helperText={help}
          slotProps={{ ...params.slotProps, inputLabel: { ...params.slotProps.inputLabel, shrink: true } }}
        />
      )}
    />
  );
  return (
    <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: 'repeat(3, 1fr)' }, columnGap: 1.5, rowGap: 2.5 }}>
      {voiceField('voice', 'Voice', 'Pick one or type a name the provider offers.', defaultVoices[0])}
      {twoSpeakers && voiceField('secondVoice', 'Second voice', 'Gemini: for scripts with two speakers, one "Name: line" per line.', defaultVoices[1])}
      <TextField
        type="number"
        label="Speed"
        value={speed ?? ''}
        placeholder={placeholders?.speechSpeed !== null && placeholders?.speechSpeed !== undefined ? String(placeholders.speechSpeed) : '1'}
        error={badSpeed}
        helperText="0.25 to 4. Gemini takes it as a slow or quick pace."
        onChange={(event) => {
          const parsed = event.target.value === '' ? null : Number(event.target.value);
          onChange({ ...value, speechSpeed: parsed === null || Number.isNaN(parsed) ? null : parsed });
        }}
        slotProps={{ inputLabel: { shrink: true }, htmlInput: { min: 0.25, max: 4, step: 0.05 } }}
      />
      <TextField
        select
        label="Format"
        value={value.audioFormat && formats.includes(value.audioFormat) ? value.audioFormat : ''}
        helperText={formats.length === 1 ? 'This model always returns WAV.' : 'MP3 is smallest. WAV is uncompressed.'}
        onChange={(event) => onChange({ ...value, audioFormat: (event.target.value || null) as AudioFormat | null })}
        slotProps={{ inputLabel: { shrink: true }, select: { displayEmpty: true } }}
      >
        <MenuItem value="">{defaultChoice(placeholders?.audioFormat ? FORMAT_LABELS[placeholders.audioFormat] : formats.length === 1 ? FORMAT_LABELS[formats[0] as AudioFormat] : 'MP3')}</MenuItem>
        {formats.map((format) => (
          <MenuItem key={format} value={format}>
            {FORMAT_LABELS[format]}
          </MenuItem>
        ))}
      </TextField>
      <TextField
        label="Style"
        value={value.speechStyle ?? ''}
        placeholder={placeholders?.speechStyle ?? 'calm and warm, unhurried'}
        helperText="Tone, pace or accent, for models that take directions. tts-1 ignores it."
        onChange={(event) => onChange({ ...value, speechStyle: event.target.value || null })}
        sx={{ gridColumn: { sm: twoSpeakers ? 'span 2' : 'span 3' } }}
        slotProps={{ inputLabel: { shrink: true } }}
      />
    </Box>
  );
}

const QUALITY_LABELS: Record<ImageQuality, string> = { low: 'Low', medium: 'Medium', high: 'High' };

/** The empty choice in a select: what an unset field falls back to. */
function defaultChoice(label: string | null | undefined): string {
  return label ? `Default (${label})` : 'Model default';
}

/** Options for image-generation models. Each provider takes the ones it understands and skips the rest. */
export function ImageParamsFields({
  value,
  onChange,
  placeholders,
}: {
  value: Partial<GenerationParams>;
  onChange: (value: Partial<GenerationParams>) => void;
  placeholders?: GenerationParams;
}) {
  return (
    <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: 'repeat(3, 1fr)' }, columnGap: 1.5, rowGap: 2.5 }}>
      <TextField
        select
        label="Aspect ratio"
        value={value.aspectRatio ?? ''}
        helperText="Width to height. OpenAI picks the nearest of square, wide or tall."
        onChange={(event) => onChange({ ...value, aspectRatio: (event.target.value || null) as AspectRatio | null })}
        slotProps={{ inputLabel: { shrink: true }, select: { displayEmpty: true } }}
      >
        <MenuItem value="">{defaultChoice(placeholders?.aspectRatio)}</MenuItem>
        {ASPECT_RATIOS.map((ratio) => (
          <MenuItem key={ratio} value={ratio}>
            {ratio}
          </MenuItem>
        ))}
      </TextField>
      <TextField
        select
        label="Resolution"
        value={value.imageSize ?? ''}
        helperText="For Gemini 3 image models (Nano Banana 2 and Pro)."
        onChange={(event) => onChange({ ...value, imageSize: (event.target.value || null) as ImageSize | null })}
        slotProps={{ inputLabel: { shrink: true }, select: { displayEmpty: true } }}
      >
        <MenuItem value="">{defaultChoice(placeholders?.imageSize)}</MenuItem>
        {IMAGE_SIZES.map((size) => (
          <MenuItem key={size} value={size}>
            {size}
          </MenuItem>
        ))}
      </TextField>
      <TextField
        select
        label="Quality"
        value={value.imageQuality ?? ''}
        helperText="For OpenAI's image models. Higher costs more."
        onChange={(event) => onChange({ ...value, imageQuality: (event.target.value || null) as ImageQuality | null })}
        slotProps={{ inputLabel: { shrink: true }, select: { displayEmpty: true } }}
      >
        <MenuItem value="">{defaultChoice(placeholders?.imageQuality && QUALITY_LABELS[placeholders.imageQuality])}</MenuItem>
        {IMAGE_QUALITIES.map((quality) => (
          <MenuItem key={quality} value={quality}>
            {QUALITY_LABELS[quality]}
          </MenuItem>
        ))}
      </TextField>
    </Box>
  );
}
