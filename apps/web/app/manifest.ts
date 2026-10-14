import type { MetadataRoute } from "next";

// Lets browsers install the app with the brand icons. The "any" icons keep the rounded tile; the
// maskable one is full bleed with the mark inside the safe zone, for launchers that crop to a shape.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Job Matcher",
    short_name: "Job Matcher",
    description:
      "Checks the job boards you follow against your resume and keeps the listings worth applying to.",
    start_url: "/home",
    display: "standalone",
    background_color: "#eef1ec",
    theme_color: "#eef1ec",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
