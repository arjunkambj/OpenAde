import { useTheme } from "next-themes";
import { Toaster as Sonner, type ToasterProps } from "sonner";
import { AlertTriangle, Check, InfoSquare, OctagonX, Spinner } from "@honeyicons/react";

const Toaster = ({ ...props }: ToasterProps) => {
  const { theme = "system" } = useTheme();

  return (
    <Sonner
      theme={theme as ToasterProps["theme"]}
      className="group"
      icons={{
        success: <Check variant="bold" className="size-4" />,
        info: <InfoSquare variant="bold" className="size-4" />,
        warning: <AlertTriangle variant="bold" className="size-4" />,
        error: <OctagonX variant="bold" className="size-4" />,
        loading: <Spinner variant="bold" className="size-4" />,
      }}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--border-radius": "var(--radius)",
        } as React.CSSProperties
      }
      toastOptions={{
        classNames: {
          toast: "cn-toast",
        },
      }}
      {...props}
    />
  );
};

export { Toaster };
