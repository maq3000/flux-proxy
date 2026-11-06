/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        canvas: "var(--bg-canvas)",
        surface: "var(--bg-surface)",
        elevated: "var(--bg-elevated)",
        hover: "var(--bg-hover)",
        selected: "var(--bg-selected)",
        hairline: "var(--border-hairline)",
        strong: "var(--border-strong)",
        fg: "var(--text-primary)",
        muted: "var(--text-secondary)",
        subtle: "var(--text-muted)",
        accent: "var(--accent-primary)",
        status2xx: {
          fg: "var(--status-2xx-fg)",
          bg: "var(--status-2xx-bg)",
        },
        status3xx: {
          fg: "var(--status-3xx-fg)",
          bg: "var(--status-3xx-bg)",
        },
        status4xx: {
          fg: "var(--status-4xx-fg)",
          bg: "var(--status-4xx-bg)",
        },
        status5xx: {
          fg: "var(--status-5xx-fg)",
          bg: "var(--status-5xx-bg)",
        },
        statusWs: {
          fg: "var(--status-ws-fg)",
          bg: "var(--status-ws-bg)",
        },
      },
      boxShadow: {
        popover: "var(--shadow-popover)",
      },
      fontFamily: {
        sans: [
          "Inter",
          "-apple-system",
          "BlinkMacSystemFont",
          "Segoe UI",
          "Roboto",
          "sans-serif",
        ],
        mono: [
          "JetBrains Mono",
          "Cascadia Code",
          "Fira Code",
          "Consolas",
          "monospace",
        ],
      },
    },
  },
  plugins: [],
};
