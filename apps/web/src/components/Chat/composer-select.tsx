import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@OpenAde/ui/components/select";

export type SelectOption = {
  value: string;
  label: string;
};

export function ComposerSelect({
  label,
  value,
  onValueChange,
  items,
  tone = "default",
}: {
  label: string;
  value: string;
  onValueChange: (value: string) => void;
  items: readonly SelectOption[];
  tone?: "default" | "permission";
}) {
  return (
    <Select
      value={value}
      onValueChange={(next) => {
        if (next) {
          onValueChange(next);
        }
      }}
      items={[...items]}
    >
      <SelectTrigger aria-label={label} size="sm" variant="ghost" tone={tone}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent align="start" alignItemWithTrigger={false} className="min-w-40">
        {items.map((item) => (
          <SelectItem key={item.value} value={item.value}>
            {item.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
