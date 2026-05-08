/** Tailwind config — kept in sync with the inline `tailwind.config = {...}`
 *  block we used to ship via the Play CDN. We precompile to docs/tailwind.css
 *  so the cold-start payload drops by ~350 KB of CDN JS. The build is run
 *  once and the output is committed; see scripts/build_tailwind.sh.
 */
module.exports = {
  content: ["./docs/index.html", "./docs/app.js"],
  theme: {
    extend: {
      fontFamily: {
        sans: [
          "Inter",
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          "Segoe UI",
          "Roboto",
          "sans-serif",
        ],
      },
      colors: {
        ink: {
          950: "#07080c",
          900: "#0b0d14",
          800: "#10131c",
          700: "#161a26",
          600: "#1f2533",
        },
        accent: {
          500: "#7c5cff",
          400: "#9d86ff",
          300: "#bfb0ff",
        },
      },
    },
  },
};
