import { hostname } from "node:os";

const HOME_HOSTNAME = "MacBook-Pro.local";

export function resolveBuildEnvironment(): string {
  return Bun.env.PI_BUILD_ENV ??
    (hostname() === HOME_HOSTNAME ? "home" : "work");
}

if (import.meta.main) {
  console.log(resolveBuildEnvironment());
}
