import type { MetadataRoute } from "next";
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "WakeBridge",
    short_name: "WakeBridge",
    description: "Seus dispositivos, por perto.",
    start_url: "/",
    display: "standalone",
    background_color: "#edf2ed",
    theme_color: "#176b4e",
    icons: [
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
  };
}
