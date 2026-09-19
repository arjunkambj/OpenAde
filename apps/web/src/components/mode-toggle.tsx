/**
 * The theme switcher.
 *
 * It persists the pick as well as applying it, because `settings.theme` is the
 * truth: `SettingsThemeSync` (above the routes) pushes that value into
 * next-themes whenever the settings doc changes, so a toggle that only called
 * `setTheme` was reverted the moment the doc ticked — the fixture pages' theme
 * button did nothing at all against a live server. Writing the setting is what
 * the theme cards on the General page do, and the sync then re-applies the same value.
 *
 * With no server the update never resolves and `setTheme` alone still holds,
 * because the settings atom never succeeds and the sync never fires.
 */

import { useAtomSet } from "@effect/atom-react";

import { Button } from "@OpenAde/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@OpenAde/ui/components/dropdown-menu";

import { useTheme } from "@/components/theme-provider";
import { useAppAtoms } from "@/lib/app-runtime";
import { Moon, Sun } from "@honeyicons/react";

const THEMES = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "system", label: "System" },
] as const;

export function ModeToggle() {
  const { theme, setTheme } = useTheme();
  const atoms = useAppAtoms();
  const updateSettings = useAtomSet(atoms.settingsUpdateAtom, { mode: "value" });

  const pick = (value: (typeof THEMES)[number]["value"]) => {
    setTheme(value);
    updateSettings({ theme: value });
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="outline" size="icon" />}>
        <Sun className="size-[1.2rem] scale-100 rotate-0 transition-all dark:scale-0 dark:-rotate-90" />
        <Moon className="absolute size-[1.2rem] scale-0 rotate-90 transition-all dark:scale-100 dark:rotate-0" />
        <span className="sr-only">Toggle theme</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {THEMES.map((item) => (
          <DropdownMenuItem
            key={item.value}
            aria-checked={theme === item.value}
            onClick={() => pick(item.value)}
          >
            {item.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
