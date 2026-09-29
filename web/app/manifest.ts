import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Everpiece",
    short_name: "Everpiece",
    description: "Send money to the right person, and let them choose what it becomes.",
    start_url: "/",
    display: "standalone",
    background_color: "#ffffff",
    theme_color: "#5b3df5",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
  };
}
