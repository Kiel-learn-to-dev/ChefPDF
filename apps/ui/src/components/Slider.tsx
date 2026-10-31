import * as RS from '@radix-ui/react-slider';
import './Slider.css';

export interface SliderProps {
  value: number;
  min: number;
  max: number;
  step?: number;
  label: string;
  onChange(value: number): void;
}

export function Slider({ value, min, max, step = 1, label, onChange }: SliderProps) {
  return (
    <RS.Root
      className="slider"
      value={[value]}
      min={min}
      max={max}
      step={step}
      onValueChange={([v]) => v !== undefined && onChange(v)}
    >
      <RS.Track className="slider__track">
        <RS.Range className="slider__range" />
      </RS.Track>
      <RS.Thumb className="slider__thumb" aria-label={label} />
    </RS.Root>
  );
}
